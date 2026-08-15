# Milestone 7: Validation pipeline

**Status: complete.**

Milestone 5 gave Rivet the right to disagree with the model. `testing` re-runs the repository's own
test script, compares the exit code against the baseline `analyzing` recorded, and lands the job on
one of five outcomes. That is one check, judged once, and it is the whole of Rivet's deterministic
validation today.

PRD §6.7 and §12.3 ask for more than one check, and PRD §11 C already told us how to read every one
of them. The milestone is not "run lint and typecheck too". It is this:

```text
a check that was red before Rivet touched anything is a property of the repository
a check that went red because of the session is a regression
a test that was already failing is not a test the agent broke
a test that is failing for the first time is the only interesting line in the report
```

M7 makes that distinction hold at two granularities. **Per check**, so `lint` failing has a baseline
of its own and is never attributed to the session unless it changed. **Per test**, so a report can
say "four tests fail, three of them already did" instead of "the suite is red".

Everything M7 adds is deterministic workflow code. No model decides what gets run, no model decides
what the result means, and nothing in this milestone is allowed to make §12.3's guarantee depend on
a session behaving well.

---

## What already exists, and what M7 actually adds

More of this checklist is already true than the list suggests:

- `analyzing` runs the repository's `test` script before anything is edited and records
  `baseline: passed | failed | skipped` on `baseline.recorded`, never failing the job for a non-zero
  exit.
- `testing` stages the tree, keeps `diff` and `diff_stat` artifacts, re-runs the same script through
  the same `probeProject`, and writes an outcome on `validation.recorded`.
- `project.ts` maps a directory listing and a manifest to a package manager and a `runScript`, and
  it is pure.
- `project-probe.ts` is the container-side half, shared by both phases specifically so they cannot
  disagree about what the test command is.
- `baseline-log.ts` and `validation-log.ts` read those facts back out of the event log rather than
  across a phase boundary, which is what keeps them true after an M6 resume.
- `recordArtifact` bounds and stores durable output, and `job_commands` already keeps a bounded
  transcript per command with a `commandId` on the event.
- killed commands (`command_timed_out`, `oom_killed`) already fail a job from either phase, and
  non-zero exits already do not.

So M7 is not building a validation system from nothing. It is generalizing a one-check comparison
into an n-check one, and adding the only genuinely new capability in the milestone: parsing test
results so failures can be attributed by name.

Its additions are:

1. a repository-specific validation configuration, inferred by default
2. a shared check runner, so every check is executed, recorded and compared the same way
3. a multi-check baseline at `analyzing`
4. a multi-check comparison at `testing`, plus targeted tests derived from the diff
5. structured test-result parsing and failure attribution
6. two durable report artifacts and a web surface that renders them
7. an aggregation rule that says which check failures actually fail a job

---

## The seven decisions this plan rests on

### 1. Validation configuration is inferred, and a committed file overrides it

PRD §6.7 says validation configuration should be repository-specific. It does not say it has to be
authored. The default source is the repository's own `package.json`: a `test`, `lint` or `typecheck`
script means that check exists, and its absence means that check is `skipped`. This is what makes
Rivet usable against a repository nobody prepared for it, which is the same property `analyzing`
already protects by refusing to fail a red baseline.

A repository that wants to be explicit commits `rivet.json` at its root. When present and valid, it
wins outright for the checks it names; checks it omits still fall back to inference. The file is
Zod-validated, and a file that is present but invalid is **terminal** (`validation_config_invalid`).
Quietly ignoring a malformed config would mean running a check set the repository explicitly asked
not to run, and reporting the result as though it had been asked for.

Commands in that file are **argv arrays, not shell strings**:

```json
{
  "validation": {
    "test": {
      "argv": ["pnpm", "test"],
      "timeoutMs": 600000,
      "reporter": { "framework": "vitest", "outputArg": "--outputFile" }
    },
    "typecheck": { "argv": ["pnpm", "typecheck"] },
    "lint": { "argv": ["pnpm", "lint"] },
    "targeted": { "argv": ["pnpm", "vitest", "run"], "appendPaths": true }
  }
}
```

A string would have to be split by something, and the something would be a shell. Every command in
this system is argv today and the sandbox port takes argv; letting a file in a cloned repository be
the one exception would be handing arbitrary repository content a shell inside the container by way
of a schema that looked convenient.

`reporter` is optional and declares what Stage 3 would otherwise have to infer. It exists for the
two cases inference cannot serve: a `test` script that already passes its own `--reporter` flag, and
the hermetic sandbox fixture of Stage 0c, which produces vitest-shaped JSON without vitest being
installed. When it is absent, detection runs; when it is present, it wins.

### 2. Every check is a `ValidationOutcome` against its own baseline

The five-outcome table M5 built is not a table about test suites. It is a table about a check with a
before and an after, and it generalizes without modification:

| baseline  | after  | outcome      |
| --------- | ------ | ------------ |
| `passed`  | passes | `verified`   |
| `passed`  | fails  | `regressed`  |
| `failed`  | passes | `fixed`      |
| `failed`  | fails  | `unresolved` |
| `skipped` | n/a    | `unverified` |

So `ValidationOutcome` is reused per check rather than replaced, `validationOutcome()` stays the
pure function it already is, and the only new pure function is the aggregation over checks. Nothing
in `@rivet/contracts` has to grow a second parallel vocabulary for the same idea.

### 3. Only a regression fails a job, with the test check keeping M5's stricter rule

The aggregation rule is where the milestone either respects PRD §11 C or quietly abandons it:

| check               | fails the job on            |
| ------------------- | --------------------------- |
| `test` (full suite) | `regressed` or `unresolved` |
| `typecheck`         | `regressed`                 |
| `lint`              | `regressed`                 |
| `targeted_test`     | never on its own            |

The test check keeps `unresolved` as terminal because that is M5's existing contract and because a
job whose whole purpose was to fix a failing suite has not done its job. `typecheck` and `lint` do
not get that rule: a repository with 300 pre-existing lint errors is a repository Rivet should still
be able to fix a bug in, and failing the job would be exactly the mistake `analyzing` was moved
before `implementing` to avoid.

`targeted_test` never fails a job by itself. The selection is a heuristic about which test file
covers which source file, and failing a job on a heuristic's guess is a worse outcome than not
running it. A targeted failure that is real will show up in the full suite a few seconds later; a
targeted failure that is an artifact of the selection would otherwise fail a perfectly good job. Its
value is speed of signal and precision of attribution, both of which survive it being non-binding.

The job-level outcome recorded on `validation.recorded` is the worst outcome across the checks that
can fail a job, ordered `regressed` > `unresolved` > `unverified` > `fixed` > `verified`.

### 4. Test results are parsed, and a parse failure is never a job failure

"Distinguish baseline failures from new failures" is only meaningful per test. A check-level
comparison can say the suite went from red to red; it cannot say that three of the four failures
were already there and the fourth is new, which is the sentence a person actually needs.

So when the runner is recognised, the test check is run a second way: with a JSON reporter writing
to a file, which is then read and parsed into a set of failing test identities. Baseline and after
sets are diffed:

```text
newFailures       = after \ baseline
preExistingFailures = after ∩ baseline
fixedFailures     = baseline \ after
```

Every part of this is best-effort. An unrecognised runner, a script that already passes its own
reporter flags, a reporter file that never appears, malformed JSON: each one degrades to check-level
comparison with `parsed: false` recorded on the report, and none of them fails a job. The parser is
a reporting improvement layered on top of a comparison that already works without it, and it must
never become a way for a job to fail because Rivet could not read a file.

Recognised for M7: **vitest** and **jest**, by inference or by an explicit `reporter` declaration in
`rivet.json`. `node:test` and everything else fall through to check-level. That is not a permanent
judgment, it is a scope line: two parsers with real fixtures beat five parsers nobody has run.

### 5. The reporter file is written outside the repository

The reporter's output file goes under `${workdir}/validation/`, never inside `${workdir}/repo/`.

This is not tidiness. `testing` stages the working tree with `git add -A` as its first act, and a
reporter file written into the repository would be staged, would appear in the `diff` artifact, and
would be counted in the numstat totals that the timeline, the report and `run.summarized` all quote.
Rivet would be reporting its own instrumentation as work the model did.

The baseline's reporter file has the same rule for a subtler reason: it is written before the diff
is ever captured, so an ignored-but-present file would still show up as an untracked addition when
`git add -A` runs later.

### 6. Targeted selection is derived from the diff, deterministically

The targeted check exists only in `testing`, because before the session there is no diff to target.
Its selection is a pure function of two inputs, both of which the phase already has or can get with
one command:

- the changed paths, from `git diff --cached --numstat`, which `testing` already runs and which
  currently throws its paths away
- the tracked file list, from one `git ls-files --cached` after staging, so newly added test files
  are visible

The mapping rules, in order:

1. a changed path that is itself a test file (`*.test.*`, `*.spec.*`, or under `__tests__/`) is
   selected directly
2. a changed source path contributes its conventional counterparts when they exist in the tracked
   list: `foo.test.ts` beside `foo.ts`, `__tests__/foo.test.ts`, `test/foo.test.ts`,
   `tests/foo.test.ts`, matched across the extensions the repository actually uses
3. the selection is capped (25 files); above the cap the check is `skipped` with the reason
   recorded, because a targeted run of everything is the full suite with a misleading name
4. an empty selection is `skipped` with its reason, never a failure

No model is asked, no prose is parsed, and the function is testable as a table with no container.

### 7. M7 adds no repair loop

PRD §11 Phase G describes implement, run targeted validation, inspect, revise, re-run. M5
deliberately shipped no repair loop, and M7 deliberately ships none either.

The reason is that M8 already owns a revision loop: review, revise, test, review again, at most two
cycles. Building a separate validation-driven loop now means building a mechanism M8 has to either
generalize or absorb, and a job would then have two independent ideas about how many times it is
allowed to try again, each with its own ceiling. M7's job is to produce a validation result precise
enough to drive that loop when it arrives: which checks failed, which tests failed, and which of
those failures are new. That is what makes M8's revision loop buildable, and it is worth strictly
more than a loop built on a coarser signal a milestone earlier.

---

## No migration

`ARTIFACT_TYPES`, `JOB_EVENT_TYPES` and `FAILURE_CATEGORIES` are Zod-validated `text`, and
`job_artifacts.metadata` and `job_events.data` are `jsonb`. Every durable thing M7 records fits
those columns. The `job_status` enum does not change, no table is added, and no column is added.

M7 therefore ships **zero migrations**, which is worth stating up front because it is a design
property rather than an accident: the vocabularies were made text precisely so that a milestone like
this one costs no DDL.

---

## The validation report contract

One structured value, produced twice per job: once by `analyzing` with no comparison, once by
`testing` with one. It is the payload of both new artifact types and the thing the web surface
renders.

```ts
export const CHECK_KINDS = ["targeted_test", "test", "typecheck", "lint"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** What one check did, before anything is compared. */
export interface CheckRun {
  kind: CheckKind;
  status: "passed" | "failed" | "skipped";
  /** Where the command came from, so a report can explain itself. */
  source: "rivet_json" | "package_json";
  argv?: string[];
  exitCode?: number | null;
  durationMs?: number;
  /** Points at the `job_commands` row holding the bounded transcript. */
  commandId?: number;
  /** Present exactly when `status` is `skipped`. */
  reason?: string;
  /** Present only for a parsed test check. */
  tests?: TestReport;
}

/** A parsed test run. Absent whenever parsing did not happen or did not work. */
export interface TestReport {
  framework: "vitest" | "jest";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Stable identities, `file::full name`, sorted. Bounded. */
  failures: string[];
  /** True only when a reporter file was read and parsed successfully. */
  parsed: boolean;
}

/** One check, compared against its baseline. */
export interface CheckComparison extends CheckRun {
  baseline: "passed" | "failed" | "skipped" | null;
  outcome: ValidationOutcome;
  /** Present only when both sides parsed. Names, not just counts. */
  attribution?: {
    newFailures: string[];
    preExistingFailures: string[];
    fixedFailures: string[];
  };
}

export interface BaselineReport {
  checks: CheckRun[];
}

export interface ValidationReport {
  /** The worst outcome across the checks that can fail a job. */
  outcome: ValidationOutcome;
  checks: CheckComparison[];
  /** The paths that drove targeted selection, bounded. */
  targetedPaths?: string[];
}
```

Both reports are canonicalized the way `ImplementationPlan` is: fields constructed in schema order,
one JSON representation regardless of who built the object. Failure name lists are bounded (200
entries, counts always exact) so a repository with 4,000 failing tests produces a report that still
fits under `RIVET_ARTIFACT_MAX_BYTES` and still tells the truth about the numbers.

---

## Stage 0 - the fixtures, and the acceptance contract

**Settled: `main` stays green, and attribution is proven on a fixture of its own.**

With a permanently failing test on `main`, the full-suite check would be `failed -> failed`, which
is `unresolved`, which is terminal. `main` is also M5's and M6's demo, and a milestone that turns
the flagship demo red to prove a point about attribution has made the point at the cost of every
other demo. So the pre-existing failure lives somewhere else.

There are two fixtures in this project and they are not the same fixture, which is the thing to get
straight before writing any of this:

| fixture                                      | used by                     | how it is built                        | network           |
| -------------------------------------------- | --------------------------- | -------------------------------------- | ----------------- |
| `github.com/xuanhieu2611/rivet-fixture-node` | `demo:job`, `demo:recovery` | a real GitHub repository, `main`       | clones over https |
| `apps/worker/tests/sandbox/fixtures/repo.ts` | `pnpm test:sandbox`         | synthetic repos served by `git-daemon` | hermetic          |

The sandbox suite never clones GitHub. It builds three tiny repositories in a temp directory, serves
their bare clones over `git://` on a local port, and selects between them with a `FixtureVariant`
union of `"green" | "failing" | "no-tests"`. That is where the attribution case belongs, because it
makes the proof hermetic, fast, and reviewable in this repository rather than in a branch of another
one.

### 0a. `rivet-fixture-node` on `main`: two scripts, still green

The only change to the external repository, and it is additive:

- a `typecheck` script that passes at the base commit
- a `lint` script that passes at the base commit
- both recorded in the fixture's README as being there for M7

No pre-existing failing test, no second branch, no change to the seeded bug. `pnpm demo:job` and
`pnpm demo:recovery` keep pointing at `main` and keep ending green, and
`apps/worker/src/job-demo.ts` and `apps/worker/src/recovery-demo.ts` need no edit at all. What the
demo gains is a per-check verdict on the closing line:

```text
baseline    test: failed (the seeded bug)
            typecheck: passed
            lint: passed
targeted    selected from the diff, ran the seeded bug's test file, passed
test        fixed
typecheck   verified
lint        verified
job         completed
```

This is a strictly better demo than M5's and it costs the external repository two lines of
`package.json`.

### 0b. A fourth sandbox variant: `"attribution"`

Extend `FixtureVariant` to `"green" | "failing" | "no-tests" | "attribution"`. The new variant is
the one that proves the milestone, and it must produce, from a single hermetic repository:

- **two failing tests at baseline**, one of which a scripted edit will fix and one of which will
  still be failing afterwards
- a `typecheck` script that passes
- a `lint` script that passes
- a source file and a conventionally-named test file beside it, so targeted selection has something
  real to select

Its expected end state is the whole acceptance contract:

```text
baseline    test: failed        2 failures: A and B
            typecheck: passed
            lint: passed
after       test: failed        1 failure: B
outcome     test check: unresolved  -> the job fails, correctly
attribution newFailures: []        <- the agent broke nothing
            preExistingFailures: [B]
            fixedFailures: [A]
```

That the job **fails** here is the point, not a problem. `unresolved` is the honest verdict for a
suite that was red and is still red, and the value M7 adds is that the report says exactly which
failure was the agent's fault: none of them. A second assertion on the same variant covers the
inverse by scripting an edit that breaks a passing test, which must produce `newFailures: [C]` and a
`regressed` outcome.

### 0c. How the hermetic variant gets a parseable test report

The existing variants run `node test.js` with an empty lockfile, so `npm ci` installs nothing and
the suite stays offline and fast. Adding vitest to a fixture would mean reaching the npm registry
from inside the container on every sandbox run in CI, which trades the suite's hermeticity for the
ability to parse a report.

It does not need to. The variant ships a `rivet.json` that declares its check commands and its
reporter framework explicitly, and a `test.js` that writes a vitest-shaped JSON report to the path
Rivet passes it before exiting non-zero. Rivet's side of the boundary is exercised in full: the
reporter argument is appended, the file is written outside the repository, it is read back under its
own cap, it is parsed, and the failure sets are diffed. Only the thing producing the JSON is a stub,
and real vitest and jest output is what the Stage 3 parser unit tests run against.

This is also why the fixture doubles as the sandbox test of the `rivet.json` path, and why decision
1's schema carries an explicit reporter declaration rather than relying only on detection:

```json
{
  "validation": {
    "test": {
      "argv": ["node", "test.js"],
      "reporter": { "framework": "vitest", "outputArg": "--outputFile" }
    },
    "typecheck": { "argv": ["node", "typecheck.js"] },
    "lint": { "argv": ["node", "lint.js"] }
  }
}
```

`reporter` is optional everywhere. When it is absent, Stage 3's `detectTestFramework` infers from
`devDependencies` and the script text as described; when it is present, it wins, which is also the
answer for the real-world repository whose `test` script already passes its own `--reporter` flag.
`outputArg` exists because vitest and jest spell it the same way today and something will not.

### 0d. What this stage produces

- two lines of `package.json` and a README note in `rivet-fixture-node`, on `main`
- `"attribution"` added to `FixtureVariant` and `buildRepository` in
  `apps/worker/tests/sandbox/fixtures/repo.ts`
- a `reporter` field in the `rivet.json` schema sketched in decision 1, carried into Stage 1
- the expected sequence in 0b written down as the assertion the Stage 10 sandbox test must make, in
  the same spirit as M6's ordered milestone trace

**Only 0a depends on a repository outside this one, and nothing blocks on it.** Stages 1 through 9
are provable entirely against the hermetic variant; 0a only needs to land before the Stage 10 demo
run.

---

## Stage 1 - contracts

Add to `@rivet/contracts`, all in new files under the existing flat layout:

- `validation-check.ts`: `CHECK_KINDS`, `CheckKind`, `CheckRun`, `TestReport`, `CheckComparison`,
  `BaselineReport`, `ValidationReport`, their Zod schemas, canonical serializers, and the pure
  aggregation `jobOutcomeFrom(checks)`.
- `validation-config.ts`: `repoValidationConfigSchema` for `rivet.json`, strict, argv arrays only,
  per-check optional `timeoutMs` bounded to the same range the worker's env allows.

Extend:

- `ARTIFACT_TYPES` with `baseline_report` and `validation_report`.
- `JOB_EVENT_TYPES` with `baseline.check_recorded` and `validation.check_recorded`.
  `baseline.recorded` and `validation.recorded` stay exactly as they are and keep their existing
  meaning, which is what keeps `baseline-log.ts`, `validation-log.ts`, the reducer and every stored
  row valid.
- `FAILURE_CATEGORIES` with `validation_config_invalid`. Terminal, classified in
  `packages/core/src/jobs/failure.ts` as a `TerminalJobError` subclass, for the same reason
  `unsupported_project` is: a malformed file in a cloned repository fails identically on every
  retry.
- `JobEventData` and its schema and normalizer with: `check`, `checkOutcome`, `checkStatus`,
  `testsTotal`, `testsFailed`, `newFailures`, `preExistingFailures`, `fixedFailures`,
  `targetedPaths`. Every one optional, every one added to all three places, because the normalizer
  drops what it does not know.

Unit tests: the aggregation table exhaustively, `rivet.json` acceptance and rejection (including a
string command being rejected with a message that says why), canonical serialization round-trips.

## Stage 2 - the validation configuration resolver

New: `packages/core/src/pipeline/validation-config.ts`, pure, importing nothing that needs a
container. Signature roughly:

```ts
resolveValidationConfig(input: {
  plan: ProjectPlan;              // from project.ts, already detected
  manifest: unknown;              // parsed package.json
  repoConfig: unknown | null;     // parsed rivet.json, or null when absent
}): ResolvedValidation
```

Returns, for each of `test`, `typecheck`, `lint`, either a resolved
`{ argv, source, timeoutMs?, reporter? }` or a `{ skipped, reason }`, plus the targeted template.
Precedence is per check: `rivet.json` entry, then `package.json` script through `plan.runScript`,
then skipped with a reason phrased for embedding in a sentence, exactly as `probeProject` already
phrases its reasons. The `reporter` on the resolved test check is either the declaration from
`rivet.json` or the result of Stage 3's detection, resolved here so that exactly one place decides
it and both phases get the same answer.

`probeProject` grows a sibling, `probeValidation`, in `project-probe.ts`: the container-side half
that reads `package.json` (it already does) and additionally `rivet.json`, and hands both to the
pure resolver. It keeps `probeProject`'s existing contract intact, including raising killed commands
and swallowing everything else as a recorded fact. `BASELINE_SCRIPT` stops being the only thing
either phase knows about, but stays exported until nothing references it.

Unit tests: the precedence matrix, all four package managers, a manifest with only `test`, a
manifest with none, a `rivet.json` naming a check the manifest lacks, an invalid `rivet.json`.

## Stage 3 - the test report parser

New: `packages/core/src/pipeline/test-report.ts`, pure.

- `detectTestFramework(manifest, scriptText)` -> `"vitest" | "jest" | null`, from
  `devDependencies`/`dependencies` and the text of the `test` script, in that order. Only consulted
  when `rivet.json` did not declare a `reporter`.
- `reporterArgs(reporter, outputPath)` -> the argv suffix to append, or null when the script cannot
  safely take one. Honours a declared `outputArg`, defaulting to `--outputFile` for both recognised
  frameworks.
- `parseVitestJson(text)` / `parseJestJson(text)` -> `TestReport`, tolerant of every shape that is
  not the answer, returning `parsed: false` rather than throwing.
- `attribute(baseline, after)` -> the three sorted, bounded name sets.

Test identity is `${file}::${fullName}` with the file made repository-relative, because an absolute
path inside a container differs between the baseline container and the M6 replacement container, and
an attribution keyed on a path that changed would report every pre-existing failure as new. That is
the single most important line in this stage.

Unit tests: real captured reporter output from both frameworks as fixtures, a truncated file, a file
that is valid JSON but not a report, an empty file, a report whose paths are absolute, and the
attribution set algebra including the case where a test is renamed (correctly: one new, one fixed).

## Stage 4 - targeted selection

New: `packages/core/src/pipeline/targeted-tests.ts`, pure.

```ts
selectTargetedTests(input: {
  changedPaths: string[];
  trackedFiles: string[];
  maxFiles: number;
}): { paths: string[] } | { skipped: true; reason: string }
```

`parseNumstat` in `validation-phase.ts` currently returns only counts and must be extended to return
paths alongside them, handling the rename form `src/{old.ts => new.ts}` by yielding the new path.
This is the one change in this stage to existing code, and its existing tests should be extended
rather than replaced.

Unit tests: the four mapping rules, the cap, an empty diff, a diff of only non-source files, a
rename, and a changed test file that is itself the counterpart of another changed file (selected
once, not twice).

## Stage 5 - the check runner

New: `packages/core/src/pipeline/check-runner.ts`. The container-side half both phases share, in the
same spirit as `project-probe.ts`: one place where a check is executed, its kills raised, its result
shaped and its event written, so `analyzing` and `testing` cannot drift about what running a check
means.

```ts
runCheck(ctx, {
  kind, argv, cwd, timeoutMs, env?, reporter?: { framework, outputPath, readMaxBytes }
}): Promise<CheckRun>
```

It runs the command through `ctx.exec` like everything else, so the transcript, `commandId` and the
`command.started` / `command.completed` pair land on the timeline unchanged. It checks
`ctx.signal.throwIfAborted()` before `commandKilledError`, in that order, for the reason both
current phases already document: a cancelled job kills the container mid-command and every command
in a killed container looks like a failing check. It then reads the reporter file with its own cap
when one was requested, and folds a `TestReport` in when parsing worked.

`PipelineOptions` grows three fields, all required, all supplied by `apps/worker`:

- `checkTimeoutMs` - lint and typecheck. Their own budget, distinct from `baselineTimeoutMs`,
  because a typecheck is not a test suite and a five-minute typecheck is a symptom where a
  five-minute suite is a Tuesday.
- `validationReportMaxBytes` - the cap on reading one reporter file. Above
  `RIVET_ARTIFACT_MAX_BYTES` for exactly the reason `diffMaxBytes` is: a JSON file clipped on the
  way out of the container is not a smaller report, it is invalid JSON, and it would degrade to
  `parsed: false` while looking like a parser bug.
- `targetedMaxFiles` - the selection cap.

`apps/worker/src/config.ts` gains `SANDBOX_CHECK_TIMEOUT_MS` (default 180_000),
`RIVET_VALIDATION_REPORT_MAX_BYTES` (default 4_194_304), and `RIVET_TARGETED_MAX_FILES` (default
25), each bounded by Zod the way its neighbours are. Core continues to read no environment and to
default nothing.

## Stage 6 - `analyzing` becomes a multi-check baseline

`baseline-phase.ts` changes from "run one script" to "run the resolved check set", and keeps every
one of its existing properties:

- a non-zero exit is still recorded and still never fails the job
- a killed command still fails the job
- a check with no command is still `skipped` with a reason, not an error

For each of `test`, `typecheck`, `lint`, in that order, it calls `runCheck` and writes a
`baseline.check_recorded` event carrying the kind, the status, the argv, the exit code and, for a
parsed test check, the totals. It then writes:

- the existing `baseline.recorded` event, unchanged in shape, whose `baseline` field is **the test
  check's status**. This is what keeps `baselineFrom()`, `readBaseline()`, `implementing`'s session
  context, and every stored row from a previous milestone correct without touching any of them.
- a `baseline_report` artifact holding the full `BaselineReport`, which is where the per-check
  detail and the failing test names actually live.

The order matters: tests first because they are the expensive one and the one everything else is
compared through, then typecheck, then lint. All three run regardless of what the earlier ones did.
A baseline that stops at the first red check is a baseline that cannot be compared against, which
defeats the phase.

## Stage 7 - `testing` becomes the multi-check comparison

`validation-phase.ts` keeps its opening exactly as it is, and this is deliberate: stage the tree,
detect an empty diff and fail `no_changes_produced`, record `diff` and `diff_stat`. Those are the
first acts because the evidence of what the model did is the most valuable thing to keep from a run
that went wrong, and nothing in this milestone may move them later.

After that, it:

1. reads `git ls-files --cached` once, and selects targeted paths from the numstat paths
2. runs `targeted_test` when there is a selection, with a reporter
3. runs `test`, with a reporter
4. runs `typecheck`
5. runs `lint`
6. reads the `baseline_report` artifact back, falling back to `readBaseline()` when a job predates
   it or when the artifact cannot be parsed
7. compares each check, attributes test failures by name where both sides parsed, and writes a
   `validation.check_recorded` event per check
8. writes the `validation_report` artifact
9. writes `validation.recorded`, unchanged in shape, whose `validation` field is the aggregated job
   outcome and which additionally carries the attribution counts
10. throws `ValidationFailedError` when the aggregation says the job failed, with a message naming
    the failing check and, when it has them, the new failures by name

Reading the baseline report back from the artifact store rather than from memory is the same rule
`baseline-log.ts` documents, and it is load-bearing rather than stylistic: after an M6 resume, this
phase runs in a process that never ran `analyzing`. A new `readBaselineReport(jobId, executor)`
belongs beside the existing readers in `packages/core/src/events/`, selecting the latest
`baseline_report` artifact for the job.

Step 6's fallback deserves stating plainly: a job whose baseline predates this milestone has a
`baseline.recorded` row and no report, so the test check compares normally and `typecheck` and
`lint` compare against a `null` baseline, which the existing table already resolves to `unverified`.
Old jobs degrade to M5 behaviour rather than to a crash.

## Stage 8 - the closing line

`finalizing-phase.ts` reads the validation result back to write `run.summarized`. It now reads the
report as well, so the closing line can be the sentence a person wants:

```text
Regressed: 2 tests newly failing (3 were already failing), typecheck verified, lint verified.
```

`validation-log.ts` grows a report-aware reader alongside `validationFrom`/`readValidation`, and
both existing functions keep working unchanged so that a job with no report still produces the M5
sentence. The `implementation_summary` artifact and everything else about this phase is untouched.

## Stage 9 - the web surface

Following the M5 and M6 pattern exactly, and adding no client-side fetching:

- timeline presentations for `baseline.check_recorded` and `validation.check_recorded`, one line
  each, naming the check and its outcome
- a **Validation** panel rendered server-side after the terminal refresh, from the
  `validation_report` artifact: one row per check with its outcome badge, and for the test check an
  expandable list of new failures, pre-existing failures and fixed failures
- the targeted selection shown as what it is, a list of paths with a count, so a reader can see why
  a targeted run passed
- `StatusBadge`'s sibling for outcomes extended to render a per-check outcome, mapped through a
  `Record<ValidationOutcome, ...>` so a new outcome breaks typecheck rather than rendering blank

No new endpoint. `/api/jobs/:id/artifacts` already lists artifact metadata and the content route
already fetches one by id, and the two new types flow through both without change.

## Stage 10 - verification

**Unit** (`pnpm test`, no infrastructure): the aggregation table exhaustively; config resolution
precedence; both reporter parsers against captured fixture output; attribution set algebra; targeted
selection rules and cap; numstat path extraction including renames; the two new event types
surviving `parseSerializedJobEvent`; report canonicalization.

**Sandbox** (`pnpm test:sandbox`), all against the hermetic `git-daemon` fixtures and none of it
touching GitHub or the npm registry:

- `green`: a real container running a real multi-check baseline, then a real comparison
- `no-tests`: `unverified` for every check, and a green job
- `failing`: the `unresolved` path at check level
- `attribution`: the Stage 0b sequence exactly, asserting `newFailures: []`,
  `preExistingFailures: [B]`, `fixedFailures: [A]` and a failed job, plus its inverse producing
  `newFailures: [C]` and `regressed`
- the reporter output file confirmed absent from `git diff --cached` and from the `diff_stat` totals
- a `rivet.json` that is present and invalid failing `validation_config_invalid`

**Integration** (`pnpm test:integration`): unchanged behaviour under `RIVET_AGENT=off`. The check
runner is only reached by the real pipeline, so the thirty-odd lifecycle tests must stay exactly as
cheap as they are.

**Demo** (`pnpm demo:job`): the flagship path stays green against `rivet-fixture-node` on `main`,
and now prints a per-check verdict. `pnpm demo:recovery` is unaffected and must stay that way; the
new checks lengthen `analyzing`, which is a phase that recovery replays, so a recovery run is the
cheapest place to notice if the baseline has become slow enough to matter.

**Docs**: `docs/architecture.md` gains the check runner and the two reports; `AGENTS.md` gains the
three new env vars, the new artifact and event types, the `rivet.json` contract, and the aggregation
rule; `README.md` gains a short section on repository-specific validation configuration.

---

## Definition of done

- [x] Baseline test, lint and typecheck all run at `analyzing` and none of them fails a job for a
      non-zero exit
- [x] Targeted tests are selected from the diff and run at `testing`, deterministically, with no
      model involvement
- [x] Full tests, lint and typecheck all re-run at `testing` and each is compared against its own
      baseline
- [x] Test results are parsed for vitest and jest, and a parse failure degrades rather than fails
- [x] New failures are distinguished from pre-existing ones by test name, proven end to end by the
      hermetic `attribution` sandbox variant in both directions
- [x] `baseline_report` and `validation_report` artifacts are stored, bounded, and canonical
- [x] A regression fails the job; a pre-existing lint or typecheck failure does not
- [x] `rivet.json` overrides inference, declares a reporter, and an invalid one is terminal
- [x] Zero migrations
- [x] The web surface renders the report, and no new endpoint was added
- [x] `demo:job` and `demo:recovery` still run against `rivet-fixture-node` on `main` and still end
      green, with no edit to either demo script
- [x] The sandbox suite still reaches neither GitHub nor the npm registry
- [x] `pnpm test`, `pnpm test:integration`, `pnpm test:sandbox`, `pnpm test:streaming`,
      `pnpm build`, `pnpm lint`, `pnpm typecheck` and `pnpm format:check` all pass

---

## Risks and deliberate limits

**The reporter flag may not be appendable.** A repository whose `test` script is
`vitest run --reporter=verbose` will end up with two reporter flags, and the behaviour is
runner-specific. Two mitigations, in order: the repository can declare `reporter` in `rivet.json`
and be exact about it, and failing that, the degradation path applies. If the file does not appear
or does not parse, the check is compared at exit-code level and says `parsed: false`. It is worth
accepting because the alternative is running the suite twice, which doubles the most expensive thing
in the pipeline to improve a report.

**Attribution assumes stable test names.** A session that renames a test produces one new failure
and one fixed one, which is correct but reads as churn. Nothing in M7 tries to be cleverer than
that, because fuzzy test identity matching is a source of confident wrong answers.

**Targeted selection is convention-based and will miss.** Integration tests that cover a file
without naming it are invisible to it. That is why it cannot fail a job.

**Three checks make `analyzing` slower to replay.** M6's phase-boundary checkpoint means it is
replayed only when a crash happens inside the phase, so the cost is bounded and paid rarely. Both
phases stay `recovery: "replay"`; nothing in this milestone has an external effect and nothing
should be tempted to declare otherwise.

**Node only, still.** `project.ts` detects four package managers and a `package.json`, and M7 does
not widen that. A Python repository has no baseline today and has no lint or typecheck check
tomorrow. `rivet.json` is the escape hatch that makes such a repository work without any of this
code learning a second ecosystem, which is a reasonable amount of leverage for one schema.

**No repair loop, by decision 7.** PRD Phase G stays open until M8.
