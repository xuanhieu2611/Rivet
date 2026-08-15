# Milestone 7: a guided tour of deterministic validation

This is a learning document. [`docs/plans/milestone-7.md`](plans/milestone-7.md) is the acceptance
contract, and [`docs/architecture.md`](architecture.md) describes the whole system as it exists
today. This guide explains what Milestone 7 added, how a job moves through it, why the
implementation makes its tradeoffs, how to verify it at several levels, and where to look when
validation behaves unexpectedly.

The implementation landed in these commits, one stage at a time:

```text
819aa3b  feat: add milestone 7 validation fixtures
3d7e82a  feat: define validation pipeline contracts
6bae7e4  feat: resolve repository validation config
f65817b  feat: parse validation test reports
70e0e9c  feat: select targeted validation tests
2f39c1f  feat: add shared validation check runner
8dd127c  feat: record multi-check validation baselines
d19b227  feat: compare multi-check validation results
06508c4  feat: summarize structured validation reports
e7e68b8  feat: render validation reports in job details
1add480  test: prove milestone 7 validation pipeline
```

The public `rivet-fixture-node` repository also gained deterministic validation scripts in commit
`e541438`.

---

## Part 0. The one idea

Milestone 5 could compare one test command before and after an agent changed a repository. Milestone
7 turns that into a deterministic validation system:

```text
repository configuration
        |
        v
resolve test, typecheck, lint, and targeted commands
        |
        v
analyzing: run full checks before the edit
        |
        +--> baseline.check_recorded events
        +--> baseline_report artifact
        |
        v
planning and implementing
        |
        v
testing: capture diff and select related tests
        |
        +--> targeted test, advisory
        +--> full test suite
        +--> typecheck
        +--> lint
        |
        v
compare each result with its own baseline
        |
        +--> validation.check_recorded events
        +--> validation_report artifact
        +--> validation.recorded compatibility event
        |
        v
fail only when a binding check introduced or retained a disallowed failure
```

The most important rule is:

> **A red command is a fact about the repository. A regression is a fact about the agent's change.**

That is why a failing baseline does not immediately fail a job. Rivet is often most useful on a
repository that is already imperfect. Validation compares the state after the edit with the state
before it and asks whether the agent made the repository worse, fixed it, left known test failures
unresolved, or could not prove anything.

---

## Part 1. What changed, and what did not

### Before M7

Milestone 5 had one inferred test script and two compatibility events:

```text
analyzing -> run test -> baseline.recorded
testing   -> run test -> validation.recorded
```

This was enough to distinguish a green suite, a fixed suite, and a regression at the process exit
code level. It could not answer:

- Did typechecking or linting get worse?
- Which named tests were already failing?
- Which failure did the agent fix or introduce?
- Can a repository override Rivet's script inference?
- Can Rivet cheaply run only tests related to the changed files first?
- Can a human inspect the complete comparison after the job finishes?

### After M7

Validation now has four check kinds:

| Check           | Runs at baseline | Runs after edit | Can fail the job by itself |
| --------------- | ---------------- | --------------- | -------------------------- |
| `targeted_test` | No               | Yes             | No                         |
| `test`          | Yes              | Yes             | Yes                        |
| `typecheck`     | Yes              | Yes             | Only on a regression       |
| `lint`          | Yes              | Yes             | Only on a regression       |

The new durable vocabulary is:

- artifacts: `baseline_report`, `validation_report`
- events: `baseline.check_recorded`, `validation.check_recorded`
- failure category: `validation_config_invalid`

The old `baseline.recorded` and `validation.recorded` events remain. Keeping them preserves
compatibility with M5/M6 readers and recovery paths while the structured artifacts carry the richer
M7 data.

### Deliberate non-goals

M7 does not add:

- a general plugin system for arbitrary validation tools
- coverage comparison
- performance benchmark comparison
- test impact analysis from an import graph
- model-selected tests
- support for every test reporter
- database migrations
- a new artifact API endpoint
- review-agent judgment, which belongs to Milestone 8
- Git commit, push, or pull request behavior, which belongs to Milestone 9

The scope is intentionally Node-oriented. Targeted selection recognizes JavaScript and TypeScript
extensions, and structured parsing supports Vitest and Jest.

---

## Part 2. Recommended reading path

Read these files in order. The sequence follows one validation result from its contract through the
pipeline and into the web page.

| #   | File                                              | What it teaches                                  |
| --- | ------------------------------------------------- | ------------------------------------------------ |
| 1   | `packages/contracts/src/validation-config.ts`     | Strict `rivet.json` schema                       |
| 2   | `packages/contracts/src/validation-check.ts`      | Checks, reports, attribution, aggregation        |
| 3   | `packages/core/src/pipeline/validation-config.ts` | Per-check configuration precedence               |
| 4   | `packages/core/src/pipeline/project-probe.ts`     | Reading configuration inside the sandbox         |
| 5   | `packages/core/src/pipeline/test-report.ts`       | Reporter detection, parsing, and attribution     |
| 6   | `packages/core/src/pipeline/targeted-tests.ts`    | Pure deterministic test selection                |
| 7   | `packages/core/src/pipeline/check-runner.ts`      | Shared command execution and best-effort reports |
| 8   | `packages/core/src/pipeline/baseline-phase.ts`    | Pre-edit check recording                         |
| 9   | `packages/core/src/pipeline/validation-phase.ts`  | Diff, post-edit checks, comparison, job failure  |
| 10  | `packages/core/src/pipeline/finalizing-phase.ts`  | Report-aware closing summary                     |
| 11  | `apps/web/components/validation-panel.tsx`        | Server-rendered validation report                |
| 12  | `apps/worker/tests/sandbox/pipeline.sbx.test.ts`  | End-to-end acceptance scenarios                  |

If you only have twenty minutes, read files 2, 3, 7, 8, 9, and 12.

---

## Part 3. The durable contracts

The contracts package defines the language shared by the worker, core, database-facing services, and
web app. The central types are in `packages/contracts/src/validation-check.ts`.

### `CheckRun`

A check run records what happened once:

```ts
type CheckRun = {
  kind: "targeted_test" | "test" | "typecheck" | "lint";
  status: "passed" | "failed" | "skipped";
  source: "rivet_json" | "package_json";
  argv?: string[];
  exitCode?: number | null;
  durationMs?: number;
  commandId?: number;
  reason?: string;
  tests?: TestReport;
};
```

Runnable checks carry command facts. Skipped checks carry a reason. A parsed test report is optional
because reporter instrumentation is deliberately best-effort.

### `CheckComparison`

A comparison adds the pre-edit status and the derived meaning:

```ts
type CheckComparison = CheckRun & {
  baseline: "passed" | "failed" | "skipped" | null;
  outcome: "verified" | "fixed" | "regressed" | "unresolved" | "unverified";
  attribution?: {
    newFailures: string[];
    preExistingFailures: string[];
    fixedFailures: string[];
  };
};
```

The baseline is `null` for a check with no comparable pre-edit result, most notably the targeted
test check.

### Canonical reports

The two artifacts are small JSON documents:

```ts
type BaselineReport = {
  checks: CheckRun[];
};

type ValidationReport = {
  outcome: ValidationOutcome;
  checks: CheckComparison[];
  targetedPaths?: string[];
};
```

Serialization always validates first, copies arrays, sorts failure names, and sorts targeted paths.
This creates a canonical representation instead of persisting whichever object shape a caller
happened to construct.

Canonical data matters for three reasons:

1. Recovery may read the artifact in a different worker process.
2. The web app should reject malformed historical data instead of guessing.
3. Stable ordering makes tests, debugging, and future checksums predictable.

Failure names and targeted paths are each bounded to 200 entries at the contract layer. The worker's
default targeted execution limit is lower, at 25 files.

---

## Part 4. Resolving repository validation configuration

Both `analyzing` and `testing` must apply the same resolution rules. M7 therefore centralizes those
rules in `resolveValidationConfig()` instead of maintaining two copies that could drift.

Each phase probes the workspace it receives. This is required for recovery, but it also means an
agent edit to `package.json`, a lockfile, or `rivet.json` can change the command selected after the
edit. The reports preserve each run's `argv` and source so that difference remains visible. M7 does
not freeze the original resolved configuration or reject a command mismatch. If exact command
identity is important for a repository, keep its validation configuration stable and review both
reported argv values.

### Precedence is per check

For `test`, `typecheck`, and `lint`, the resolver uses:

```text
explicit rivet.json entry
        |
        | absent
        v
non-empty package.json script
        |
        | absent
        v
recorded skip with a reason
```

This is per check, not per file. A repository can override its test command in `rivet.json` while
still allowing typecheck and lint to come from `package.json`.

### The `rivet.json` contract

A complete example is:

```json
{
  "validation": {
    "test": {
      "argv": ["pnpm", "test"],
      "timeoutMs": 600000,
      "reporter": {
        "framework": "vitest",
        "outputArg": "--outputFile"
      }
    },
    "typecheck": {
      "argv": ["pnpm", "typecheck"]
    },
    "lint": {
      "argv": ["pnpm", "lint"]
    },
    "targeted": {
      "argv": ["pnpm", "vitest", "run"],
      "appendPaths": true,
      "reporter": {
        "framework": "vitest"
      }
    }
  }
}
```

Important properties:

- The schema is strict. Unknown fields are rejected.
- Commands are argv arrays, never shell strings.
- `timeoutMs` is optional and must be from 1,000 through 3,600,000 milliseconds.
- Reporters support `vitest` and `jest`.
- `appendPaths` is required for an explicit targeted command.
- Omitted checks still fall back to `package.json`.

### Why argv arrays

An argv array keeps execution shell-free. Rivet can pass the exact executable and arguments to the
sandbox without interpreting quotes, substitutions, pipes, redirects, or platform-specific shell
syntax. It is easier to validate and does not turn repository configuration into an accidental
shell-injection boundary.

### Why invalid `rivet.json` is terminal

An absent file means the repository accepts inference. A present file means the repository has made
an explicit request. Silently ignoring a malformed, unreadable, truncated, or schema-invalid file
could run checks the repository intended to replace.

M7 therefore raises `validation_config_invalid`. This is terminal and is not retried, because
another attempt will not repair repository configuration.

### Targeted fallback

When `validation.targeted` is absent, the targeted check inherits the resolved full test command and
reporter, then appends selected paths. If the full test check is skipped, targeted testing is
skipped for the same reason.

This provides useful behavior for ordinary Vitest and Jest repositories with no Rivet-specific
configuration while preserving an explicit escape hatch for unusual runners.

---

## Part 5. Reporter detection, parsing, and attribution

Exit codes tell Rivet whether a suite is red. Reporter JSON tells Rivet which tests are red.

### Framework detection

For an inferred test script, `detectTestFramework()` checks:

1. `devDependencies` for `vitest`, then `jest`
2. `dependencies` for `vitest`, then `jest`
3. the test script for a command token naming `vitest` or `jest`

An explicit reporter in `rivet.json` wins because repository knowledge is more reliable than
heuristics.

### Reporter arguments

Rivet appends:

```text
Vitest: --reporter=json --outputFile <path>
Jest:   --json --outputFile <path>
```

An explicit `outputArg` replaces `--outputFile` exactly. This accommodates wrappers whose output
flag differs.

The generated file lives under:

```text
<sandbox workdir>/validation/
```

The repository clone lives under:

```text
<sandbox workdir>/repo/
```

Keeping reporter output outside the clone is essential. Rivet's instrumentation must never appear in
the user's Git diff, file totals, checkpoint, or eventual commit.

### Best-effort degradation

The repository command remains authoritative. If reporter setup or parsing fails, Rivet still uses
the command exit code.

These conditions degrade to an exit-code-only result:

- reporter directory creation fails
- reporter arguments cannot safely be formed
- the reporter file is absent
- the file exceeds the complete-read cap
- sandbox file reading fails
- JSON is malformed
- required fields have unexpected shapes
- the runner is unsupported

In those cases, `CheckRun.tests` is omitted. The job does not fail because Rivet's optional
instrumentation failed.

Cancellation, timeout, and OOM are different. They remain authoritative sandbox or job failures and
are never hidden as reporter degradation.

### Stable test identities

Both supported reporters are normalized to:

```text
repository/relative/file::full test name
```

For example:

```text
src/discount.test.ts::bulk discount applies to exactly ten items
```

Absolute container prefixes are removed. This is required for M6 recovery because the replacement
worker provisions a new container. A test identity must match its earlier baseline even when the
absolute filesystem path changes.

### Attribution as set algebra

Given baseline failure set `B` and after-edit failure set `A`:

```text
new failures          = A - B
pre-existing failures = A intersection B
fixed failures        = B - A
```

Names are deduplicated, sorted, and capped at 200. Counts in the report still describe the runner's
full totals, while the name list is bounded for storage and display.

A particularly important rule is that any parsed new named test failure makes the full test check
`regressed`, even if the suite was red before and remains red after. Exit codes alone would call
that red-to-red case `unresolved` and miss the newly introduced breakage.

---

## Part 6. Deterministic targeted test selection

Targeted tests are an advisory early signal. They do not replace the full suite and never fail the
job by themselves.

The selector is a pure function of:

- changed paths from `git diff --cached --numstat`
- exact tracked files from `git ls-files --cached`
- the configured maximum file count

It does not inspect file contents, walk the filesystem, call a model, or use a network service. The
same Git state therefore produces the same selection after recovery.

### Supported source extensions

```text
js jsx ts tsx mjs cjs mts cts
```

### Selection rules

If a changed file is already a test under `__tests__` or has `.test.*` or `.spec.*`, Rivet selects
that exact tracked file.

For a changed source such as:

```text
packages/cart/src/price.ts
```

Rivet looks for tracked test or spec counterparts in four conventional locations:

```text
packages/cart/src/price.test.ts
packages/cart/src/__tests__/price.test.ts
packages/cart/test/price.test.ts
packages/cart/tests/price.test.ts
```

It also tries `spec` and every supported source extension already present in the tracked file set.
Candidates are accepted only by exact tracked membership, then deduplicated and sorted.

### When targeted testing is skipped

The selector records a reason when:

- the diff has no paths
- the diff contains only non-source files
- no conventional tracked test matches
- the selection exceeds `RIVET_TARGETED_MAX_FILES`
- no test command can be resolved

Skipping when the set is too large avoids running a second full suite and misleadingly calling it a
targeted run.

### Why targeted tests are non-binding

Convention-based selection is incomplete by design. A distant integration test can depend on a
changed module without sharing its filename or directory. A targeted failure is useful evidence, but
a targeted pass is not proof. The full suite remains the binding check.

---

## Part 7. One shared check runner

`runCheck()` is the common execution primitive for baseline and validation. It:

1. builds optional reporter arguments
2. refuses reporter output paths inside the repository
3. executes through `PhaseContext.exec()`
4. preserves cancellation before classifying the command result
5. turns timeout or OOM into the existing sandbox failure categories
6. reads and parses reporter output under a dedicated cap
7. returns one `CheckRun`

Running through `PhaseContext.exec()` preserves everything earlier milestones established:

- `command.started` and completion/failure lifecycle events
- append-only `job_commands` rows
- bounded stdout and stderr
- cancellation behavior
- sandbox ownership
- command correlation ids

Centralizing this logic prevents subtle drift. For example, baseline and validation cannot disagree
about whether a missing reporter should fail the job.

---

## Part 8. The baseline phase

`analyzing` now resolves and runs checks in a fixed order:

```text
test -> typecheck -> lint
```

Every check is attempted even if an earlier one exits non-zero. A red test suite must not hide a
useful typecheck or lint baseline.

For each check, the phase records `baseline.check_recorded`. After all three, it writes a complete,
canonical `baseline_report` artifact.

It also writes the legacy `baseline.recorded` event from the test result only. Older code can keep
reading the M5 shape while M7 readers use the report.

### Why a red baseline is not a job failure

A non-zero exit is repository state. The job continues so the agent can repair it. A command killed
by timeout or OOM is different because Rivet did not obtain a trustworthy baseline. Those failures
escape immediately under their existing categories.

### Timeouts

- Test uses `SANDBOX_BASELINE_TIMEOUT_MS` by default.
- Typecheck and lint use `SANDBOX_CHECK_TIMEOUT_MS` by default.
- A per-check `rivet.json` timeout overrides the worker default.

---

## Part 9. The validation phase

`testing` performs work in this order:

1. `git add -A`
2. capture `git diff --cached --numstat`
3. capture `git diff --cached`
4. fail `no_changes_produced` if the diff is empty
5. persist `diff` and `diff_stat`
6. read tracked paths with `git ls-files --cached`
7. deterministically select targeted tests
8. resolve validation configuration again from the restored workspace
9. run `targeted_test`, `test`, `typecheck`, and `lint` in that order
10. read `baseline_report`, with a legacy baseline fallback for older jobs
11. compare each check
12. record `validation.check_recorded` events
13. persist `validation_report`
14. record the legacy aggregate `validation.recorded` event
15. throw `validation_failed` if a binding comparison requires it

The diff artifacts are written before later validation work. If configuration or a check fails, the
human can still inspect what the agent changed.

### Per-check comparison table

The primitive exit-code comparison is:

| Baseline | After   | Outcome      | Meaning                                  |
| -------- | ------- | ------------ | ---------------------------------------- |
| passed   | passed  | `verified`   | stayed green                             |
| passed   | failed  | `regressed`  | the change made the check red            |
| failed   | passed  | `fixed`      | the change repaired the check            |
| failed   | failed  | `unresolved` | the check was red and remains red        |
| skipped  | any     | `unverified` | there is no comparable baseline          |
| absent   | any     | `unverified` | legacy or incomplete evidence            |
| any      | skipped | `unverified` | the after-state could not be established |

Parsed new named failures override the red-to-red row for the full test suite and make it
`regressed`.

### Which outcomes fail the job

| Check           | Failing outcomes          |
| --------------- | ------------------------- |
| `targeted_test` | none                      |
| `test`          | `regressed`, `unresolved` |
| `typecheck`     | `regressed`               |
| `lint`          | `regressed`               |

This policy is deliberate:

- An unresolved full test failure still means the requested change is not validated.
- Pre-existing typecheck and lint debt should not prevent unrelated work.
- A newly introduced typecheck or lint failure is a regression and must fail.
- A heuristic targeted run is useful evidence but never authoritative.

### Job-level aggregation

The report's overall outcome is the worst binding result in this order:

```text
regressed > unresolved > unverified > fixed > verified
```

There are two adjustments:

- `targeted_test` is excluded.
- `unresolved` typecheck or lint is treated as `unverified` for aggregation.

If no binding check contributes useful evidence, the job-level result is `unverified`, not
`verified`. Lack of evidence is not proof.

---

## Part 10. Artifacts, events, and recovery

M7 stores detail at three levels because each has a different audience.

### Command rows

`job_commands` keeps the exact command, exit code, duration, and bounded transcript. Use it when you
need stderr or stdout.

### Events

Per-check events keep compact timeline facts:

```text
baseline.check_recorded
validation.check_recorded
```

They include the check kind, status, command metadata, parsed totals when available, comparison
outcome, attribution counts, and targeted paths where relevant. They do not include every failure
name, which keeps ordinary timeline reads bounded.

The compatibility events remain:

```text
baseline.recorded
validation.recorded
```

### Report artifacts

The complete structured data lives in:

```text
baseline_report
validation_report
```

These artifacts opt into complete storage. Head-and-tail truncation would produce invalid JSON, so a
report is either complete or refused.

Reporter input has a separate `RIVET_VALIDATION_REPORT_MAX_BYTES` cap, which must be greater than
`RIVET_ARTIFACT_MAX_BYTES`. The first bounds raw runner output; the second bounds the canonical
artifact stored in Postgres.

### Why phases read artifacts back

`runPipeline()` does not pass arbitrary phase results through process memory. More importantly, M6
can resume `testing` in a new process and a new container. Validation therefore reads the durable
`baseline_report` artifact, and finalization reads the durable `validation_report` artifact.

This is not extra ceremony. It is what makes M7 compatible with crash recovery.

### Legacy fallback

If a job predates M7 and has no `baseline_report`, validation falls back to the old
`baseline.recorded` event for its full test comparison. Other checks become unverified. Old durable
history remains readable after deployment.

---

## Part 11. The web surface

The job detail page fetches artifact metadata alongside events and commands, then fetches the latest
diff, implementation summary, implementation plan, and validation report in parallel.

`ValidationPanel` is server-rendered. It shows:

- overall outcome
- one row per check
- baseline and after status
- parsed test totals
- outcome badges
- skip reasons
- expandable new, pre-existing, and fixed failures
- expandable targeted path selection

No new endpoint was required. The page uses the existing artifact list and artifact detail services.
Keeping the panel server-rendered also avoids expanding the live client-state boundary. The existing
timeline still receives per-check events live; the terminal refresh loads the final report panel.

Unreadable, truncated, or historical report artifacts degrade to an explanatory empty state rather
than crashing the page.

---

## Part 12. Configuration added by M7

Three worker settings were added:

| Variable                            | Default   | Allowed range         | Purpose                                    |
| ----------------------------------- | --------- | --------------------- | ------------------------------------------ |
| `SANDBOX_CHECK_TIMEOUT_MS`          | `180000`  | 1,000 to 3,600,000 ms | Default typecheck and lint timeout         |
| `RIVET_VALIDATION_REPORT_MAX_BYTES` | `4194304` | up to 16 MiB          | Complete reporter-file read cap            |
| `RIVET_TARGETED_MAX_FILES`          | `25`      | 1 to 200              | Maximum conventionally selected test files |

Worker startup validates bounds and cross-limit invariants. In particular:

```text
RIVET_VALIDATION_REPORT_MAX_BYTES > RIVET_ARTIFACT_MAX_BYTES
RIVET_DIFF_MAX_BYTES > RIVET_ARTIFACT_MAX_BYTES
```

Core does not read environment variables. The worker parses policy and passes explicit values in
`PipelineOptions`, preserving the shared-package boundary.

---

## Part 13. How to test and verify M7

Use the smallest layer that can answer your question. The complete ladder is below.

### Level 1: focused pure logic, no services

This is the fastest feedback loop for editing M7 behavior:

```bash
pnpm --filter @rivet/contracts test src/validation-config.test.ts src/validation-check.test.ts

pnpm --filter @rivet/core test \
  src/pipeline/validation-config.test.ts \
  src/pipeline/test-report.test.ts \
  src/pipeline/targeted-tests.test.ts \
  src/pipeline/check-runner.test.ts \
  src/pipeline/baseline-phase.test.ts \
  src/pipeline/validation-phase.test.ts

pnpm --filter @rivet/web test \
  lib/validation-report.test.ts \
  components/validation-presentation.test.ts
```

These tests need no database, Redis, Docker, or model key.

They prove:

- strict config parsing and per-check precedence
- the exhaustive aggregation table
- Vitest and Jest parsing
- bounded stable failure identities
- targeted test conventions
- reporter degradation
- baseline and validation event/artifact behavior
- UI rendering and malformed-artifact fallback

### Level 2: the repository-wide offline gate

Run the same checks CI's verification job uses:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

These must succeed with no database, Redis, or Docker. If they unexpectedly try to connect to an
external service, an import-time boundary has been broken.

### Level 3: worker integration tests with Postgres and Redis

Start local services:

```bash
brew services start postgresql@17
redis-server --port 6379 --daemonize yes --save "" --appendonly no
```

Then run:

```bash
pnpm test:integration
```

This suite uses real Postgres, Redis, BullMQ, and the production worker processor, but uses the
simulated sandbox or scripted agent where appropriate. It proves that M7 events and artifacts flow
through the job lifecycle and that validation failures reach the correct terminal category.

The suite truncates job tables. It reads `.env.test`, not `.env.local`, and refuses a non-local
database unless you explicitly override the safety guard.

### Level 4: real Docker sandbox acceptance

Keep the local Postgres and Redis services from Level 3 running, and make sure Docker is running:

```bash
docker version
```

The output must contain both a Client and Server section. Then run:

```bash
pnpm test:sandbox
```

For a faster M7-only loop:

```bash
pnpm --filter @rivet/worker test:sandbox tests/sandbox/pipeline.sbx.test.ts
```

The hermetic fixture repositories are served by a local Git daemon. Their `.npmrc` points to a
closed local registry, so an accidental npm network request fails instead of reaching the public
registry.

The M7 sandbox cases prove:

| Scenario                     | Expected result                                     |
| ---------------------------- | --------------------------------------------------- |
| green test/typecheck/lint    | completed, overall `verified`                       |
| no checks                    | completed, all checks `unverified`                  |
| unchanged failing test suite | failed, test `unresolved`                           |
| fix named failure A, keep B  | A fixed, B pre-existing, job still fails unresolved |
| introduce named failure C    | C new, overall `regressed`                          |
| invalid `rivet.json`         | terminal `validation_config_invalid`, one attempt   |
| reporter output              | absent from Git diff and diff totals                |

You can run one case by its test name:

```bash
pnpm --filter @rivet/worker test:sandbox \
  tests/sandbox/pipeline.sbx.test.ts \
  -t "classifies a newly broken named test as a regression"
```

### Level 5: streaming and web regression coverage

With local Postgres running:

```bash
pnpm test:streaming
```

M7 did not create a new stream, but it added event types consumed by the existing timeline. This
suite confirms the SSE transport remains correct. Web unit tests cover the new presentation.

Like the integration suite, streaming tests truncate local job tables and refuse a remote database
by default.

### Level 6: real end-to-end job

Requirements:

- local Postgres
- local Redis
- Docker
- `OPENROUTER_API_KEY`
- `.env.local` configured
- `RIVET_SANDBOX=docker`
- `RIVET_AGENT=pi`

Run:

```bash
pnpm demo:job
```

The demo clones `xuanhieu2611/rivet-fixture-node` on `main`, asks a real coding agent to fix the
bulk discount boundary, and exercises the production worker wiring.

Look for this sequence in the output:

```text
baseline.check_recorded:test
baseline.check_recorded:typecheck
baseline.check_recorded:lint
baseline.recorded
validation.check_recorded:targeted_test
validation.check_recorded:test
validation.check_recorded:typecheck
validation.check_recorded:lint
validation.recorded
run.summarized
```

The expected check results for the fixture are:

```text
test:      fixed
typecheck: verified
lint:      verified
job:       completed
```

The exact agent text and command count can vary because this is a real model session. The validation
facts should not.

### Level 7: recovery plus validation

Run:

```bash
pnpm demo:recovery
```

This kills a worker during implementation, reclaims the job, restores the workspace into a new
container, resumes with a fresh scripted session, and validates the final result against the
pre-crash baseline.

The important M7 assertion is that the restored job still ends with the fixture's test check
`fixed`. This proves baseline and validation data are durable across the M6 recovery boundary.

Do not run this demo while another development worker is consuming the same Redis queue. A separate
worker can claim the demo job and invalidate the experiment. Stop `pnpm dev` first, or use isolated
local Postgres and Redis instances.

### Complete release gate

Before declaring an M7 change safe, run:

```bash
pnpm test
pnpm test:integration
pnpm test:sandbox
pnpm test:streaming
pnpm build
pnpm lint
pnpm typecheck
pnpm format:check
git diff --check
```

For changes to recovery, configuration resolution, or phase ordering, also run both demos.

---

## Part 14. Manual verification in the application

For an interactive inspection:

1. Configure `.env.local`.
2. Start Postgres, Redis, and Docker.
3. Run `pnpm dev`.
4. Open `http://localhost:3000`.
5. Create a job against a repository with `test`, `typecheck`, and `lint` scripts.
6. Wait for the terminal status.
7. Open the job detail page.

Verify the following:

- The timeline contains three baseline check events.
- The timeline contains targeted, full test, typecheck, and lint validation events.
- The Validation panel shows the overall outcome and one row per check.
- The targeted selection expands to repository-relative paths when matches exist.
- Failure attribution expands into new, pre-existing, and fixed names when parsing succeeds.
- Artifacts include `baseline_report`, `diff`, `diff_stat`, and `validation_report`.
- The diff does not contain a `validation/` reporter directory.
- A failing binding result leaves the diff available for inspection.

### Inspecting raw artifacts through the existing API

List artifacts:

```bash
curl -s http://localhost:3000/api/jobs/JOB_ID/artifacts | jq
```

Find the `validation_report` id, then read it:

```bash
curl -s \
  http://localhost:3000/api/jobs/JOB_ID/artifacts/ARTIFACT_ID \
  | jq -r '.content' \
  | jq
```

The first `jq` extracts the artifact's JSON string. The second formats the report stored inside that
string.

Inspect the timeline as ordinary JSON:

```bash
curl -s -H 'Accept: application/json' \
  http://localhost:3000/api/jobs/JOB_ID/events \
  | jq '.events[] | select(.type | test("baseline|validation"))'
```

Inspect command summaries:

```bash
curl -s http://localhost:3000/api/jobs/JOB_ID/commands | jq
```

Use the command detail endpoint or the UI's Sandbox commands panel to read the bounded transcript
for a specific command.

---

## Part 15. Debugging guide

Start with the observed symptom, then follow the shortest path below.

### A check was unexpectedly skipped

Inspect, in order:

1. `baseline.check_recorded` or `validation.check_recorded` reason
2. the repository's root `rivet.json`
3. the relevant `package.json` script
4. package-manager detection from the lockfile
5. `validation-config.ts` resolver tests

For targeted tests, also inspect `validation_report.targetedPaths` and the selector's skip reason.
Remember that candidates must be tracked by Git and follow one of the supported conventions.

### The wrong command ran

Check the event's `argv` and `source` fields.

- `source: rivet_json` means the explicit entry won.
- `source: package_json` means the package script was inferred.

If targeted used the full test command, that is the normal fallback. Add an explicit
`validation.targeted` entry when the runner needs different arguments.

### A test suite failed but there is no attribution

Inspect the command transcript first. Then check:

- Was Vitest or Jest detected?
- Did `rivet.json` declare the correct reporter?
- Did the command already supply conflicting reporter flags?
- Could the runner write the output file?
- Did the file exceed `RIVET_VALIDATION_REPORT_MAX_BYTES`?
- Does the JSON contain the expected common fields?

Reporter failure intentionally leaves `tests` absent. The exit-code comparison is still valid.

### Reporter files appeared in the diff

This should never happen. Verify:

- `SANDBOX_WORKDIR` is absolute.
- The clone is still at `<workdir>/repo`.
- Reporter output is under `<workdir>/validation`.
- New code did not bypass `runCheck()` and write inside the repository.

The Stage 10 sandbox test specifically guards this invariant.

### A red baseline failed the job too early

A normal non-zero baseline must not fail the job. Look for a different category:

- `command_timed_out`
- `oom_killed`
- cancellation
- `validation_config_invalid`

Those describe Rivet's inability to establish a trustworthy baseline, not ordinary repository debt.

### Pre-existing typecheck or lint debt failed the job

An unresolved typecheck or lint result should contribute `unverified` at job level and should not be
a binding failure. Check `jobOutcomeFrom()` and `isBindingFailure()` separately. Aggregation
controls the displayed overall outcome; binding failure controls whether the phase throws.

### An already-red test suite gained a new failure but says unresolved

Attribution must be present on both baseline and after reports. When it is, any `newFailures` entry
overrides red-to-red exit comparison to `regressed`. If attribution is absent, debug reporter
parsing before changing the comparison table.

### The Validation panel is empty

Check:

1. whether a `validation_report` artifact exists
2. whether the job reached `testing`
3. whether the artifact is complete and untruncated
4. whether `readValidationReport()` accepts its schema
5. whether this is an older M5/M6 job with only timeline events

The panel intentionally does not invent a report from compact event rows.

### A recovery run cannot find its baseline

Confirm that `baseline_report` was stored before the analyzing checkpoint completed. Then inspect
`PhaseContext.readBaselineReport()` and the checkpoint/resume events. The compatibility fallback can
recover only the full test baseline, not typecheck or lint detail.

---

## Part 16. Safe extension recipes

### Add another supported reporter

You would need to change all of these together:

1. extend `TEST_FRAMEWORKS` and its Zod enum
2. update the `rivet.json` reporter schema
3. add detection logic
4. add reporter argv construction
5. implement a tolerant parser into the common `TestReport`
6. add a trimmed real fixture and parser tests
7. dispatch the parser in `runCheck()`
8. add sandbox acceptance coverage

Do not expose runner-specific shapes beyond `test-report.ts`. The rest of the pipeline should keep
consuming the common contract.

### Add another binding check

This is larger than adding a command. You must decide:

- whether it runs at baseline, validation, or both
- its configuration precedence
- its timeout policy
- whether unresolved debt is allowed
- which outcomes fail a job
- how it contributes to aggregation
- whether it needs structured parsing
- how it appears in events, reports, finalization, and the UI
- how older jobs without its baseline degrade

Then extend the exhaustive contract and phase tests before wiring execution.

### Improve targeted selection

Keep the selector pure and deterministic. Good future inputs include a committed dependency graph or
framework-owned test map. Avoid filesystem timing, model judgment, or network lookup in the
selection function. Recovery must reproduce the same set from the same durable workspace.

### Add coverage comparison

Treat coverage as a new structured artifact, not as extra fields smuggled into `TestReport`. Define
its canonical schema, bounds, baseline semantics, recovery behavior, and binding policy first.

---

## Part 17. Design decisions to preserve

The implementation contains several boundaries that are easy to weaken accidentally.

1. **Configuration resolution is centralized.** Baseline and validation must not invent separate
   precedence rules.
2. **Repository commands are argv arrays.** Do not introduce shell-string execution through
   `rivet.json`.
3. **Reporter parsing is optional.** Instrumentation failure must not replace the command result.
4. **Reporter output stays outside the clone.** Rivet must not modify the user's diff by observing
   it.
5. **Targeted tests are advisory.** Convention matching cannot prove the full repository is green.
6. **Every binding check has its own baseline.** Comparing lint with a test baseline has no meaning.
7. **Pre-existing debt is distinct from regression.** This is the product reason M7 exists.
8. **Reports are canonical and complete.** Truncated JSON is not a smaller valid report.
9. **Artifacts cross phase and process boundaries.** Do not rely on in-memory phase output.
10. **Events are summaries; artifacts hold detail.** Failure names do not belong in every timeline
    query.
11. **Core receives configuration as arguments.** It must not read worker environment variables.
12. **Old events remain readable.** Compatibility fallbacks make deployment safe for existing jobs.

---

## Part 18. A practical learning exercise

To internalize M7, make a tiny local repository with:

```json
{
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  },
  "devDependencies": {
    "vitest": "4.1.10"
  }
}
```

Add two initially failing named tests, A and B. Then try three independent jobs:

1. Fix A and leave B failing.
2. Leave A and B failing and introduce C.
3. Fix both A and B.

Predict the report before running each job:

| Change          | New | Pre-existing | Fixed | Test outcome | Job result                           |
| --------------- | --- | ------------ | ----- | ------------ | ------------------------------------ |
| fix A, retain B | 0   | B            | A     | unresolved   | failed                               |
| add C           | C   | A, B         | 0     | regressed    | failed                               |
| fix A and B     | 0   | 0            | A, B  | fixed        | completes if other checks bind green |

Then temporarily break lint before the baseline and leave it unchanged. The job should remain able
to complete with lint treated as pre-existing debt. Finally, make lint green at baseline and break
it in the edit. That job should fail as a lint regression.

This exercise demonstrates why process exit codes, named attribution, per-check baselines, and
binding policy are separate concepts.

---

## Part 19. Completion checklist

When changing M7 in the future, ask:

- Did command resolution remain identical between baseline and validation?
- Does a red baseline still continue unless the command was killed?
- Are all checks recorded even when an earlier one is red?
- Is targeted selection deterministic, sorted, bounded, and tracked-file-only?
- Does the full suite still run after targeted tests?
- Are reporter failures still best-effort?
- Can reporter output ever enter the repository diff?
- Are new named failures on a red suite classified as regressions?
- Are pre-existing typecheck and lint failures non-binding?
- Are reports strict, canonical, bounded, and complete?
- Can a replacement worker read everything it needs from durable state?
- Do old jobs still degrade through compatibility events?
- Does the web page reject malformed reports safely?
- Do offline tests still run without external services?
- Do integration tests refuse a remote destructive database by default?
- Does the sandbox suite remain hermetic?

If all of those answers are yes and the complete release gate passes, the validation pipeline still
has the properties Milestone 7 was built to establish.
