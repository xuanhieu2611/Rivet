# Milestone 10: Evaluation harness

M9 was the milestone where Rivet started producing pull requests. M10 is the milestone where Rivet
starts producing **numbers about itself** - and that is a different kind of engineering. Everything
up to here answers "did this job work". M10 answers "how often does this system work, on what kinds
of task, at what cost, and where does it fail" - which is the only question that separates a demo
from a platform, and the one an interviewer will actually ask.

The PRD checklist (§2699):

- [ ] Benchmark schema
- [ ] First 5 tasks
- [ ] Evaluation runner
- [ ] Hidden test support
- [ ] Store run metrics
- [ ] Categorize failures
- [ ] Evaluation dashboard
- [ ] Expand to 20 tasks
- [ ] Eventually 30-50 tasks
- [ ] _Optional experiment:_ `reviewMode: "independent"` vs `"none"` over the same task set (§25
      Experiment 1)

Plus the standing constraints: §24.1 (the case fields), §24.2 (reproducibility: pinned commit,
pinned dependencies, pinned image, pinned configuration), §24.3 (machine-verifiable primary success,
reviewer score secondary), §24.4 (the four metric families), §24.5 (the failure taxonomy), §10.9
(the `EvaluationRun` shape), §18.6 (the dashboard) and §19 (the REST sketch).

**Scope decision, taken up front:** this milestone ships the harness and the first **5** tasks, runs
Experiment 1 over them, and treats "expand to 20" and "eventually 30-50" as follow-on authoring work
rather than milestone scope. Five cases is enough to exercise every part of the harness - a case
that passes, a case that fails a hidden test, a case that fails validation, a case that exhausts the
review loop, a case that is genuinely hard - and the marginal architectural insight from cases six
through twenty is close to zero. The checklist entries stay unchecked and say so.

---

## What already exists, and what M10 actually adds

More of the measurement is already in the database than it looks, which is the whole reason this
milestone is tractable.

- **Every metric §24.4 asks for is already recorded per job.** `jobs` carries `total_input_tokens`,
  `total_output_tokens`, `total_cost_usd`, `total_model_calls`, `total_tool_calls`, `total_turns`,
  `attempt_count`, `review_loops`, `review_decision`, `review_blocking_count`, `started_at`,
  `completed_at`, `status`, `failure_category`. Runtime is a subtraction. Efficiency metrics are an
  aggregate query. M10 does not instrument anything new on the job path; it reads what M4-M8 already
  write.
- **Quality metrics are already an artifact.** The canonical `validation_report` distinguishes new,
  pre-existing and fixed test failures per check and carries the job's aggregate outcome, so
  "regression count" and "tests passed" are a parse away. The `diff_stat` artifact answers
  "unnecessary-file-change count". The `review_report` answers "review acceptance".
- **Reproducibility is already recorded.** `jobs.env_fingerprint` holds the image digest, node
  version, package manager and version, lockfile hash, resolved commit and resource limits. §24.2's
  requirement is largely satisfied; M10's job is to _pin the inputs_ to match, and to read the
  fingerprint back when a result is disputed.
- **A lossless final workspace exists after every run.** Phase-boundary checkpoints capture a binary
  patch against the job's immutable `base_commit_sha`, verified by SHA-256. The last checkpoint of a
  finished job **is** the graded tree, in bytes, in Postgres - which is what makes hidden-test
  grading a separate, re-runnable step rather than a hook inside the pipeline.
- **Seeding a sandbox from a host archive already works.** M9's `seedClone` clones on the worker
  host, tars the tree (`--no-xattrs`, `COPYFILE_DISABLE=1`) and `putArchive`s it into the container.
  A local bare repository is the same operation with a different remote and no token.
- **`RIVET_SANDBOX` / `RIVET_AGENT` / `RIVET_GITHUB` already establish the switch family**, complete
  with the rule that the cheap variants are refused under `NODE_ENV=production`.

So M10 adds five things and **no new pipeline phase, no new job status, and no change to how a job
executes**:

1. **A benchmark case format and a fixture builder** - git-tracked seed trees that build into local
   bare repositories with pinned commits.
2. **A local seed source**, so a job can run against one of those repositories without GitHub and
   without a public URL.
3. **An evaluation runner CLI** that creates real jobs through the real queue, waits, and grades.
4. **A grader** that provisions a fresh container from the final checkpoint and runs hidden tests.
5. **A metrics store** (`benchmark_cases`, `evaluation_suites`, `evaluation_runs`) plus a numeric
   dashboard and the `/api/evaluations` reads.

---

## The nine decisions this plan rests on

### 1. An evaluation run **is** a job, executed by the real worker

The runner does not call `buildPipeline()`. It calls `createJob()` and `requestJobRun()`, exactly
like the web app does, and a real worker claims the job under a real Postgres lease and runs the
unchanged pipeline. `evaluation_runs.job_id` points at the row.

This is the single most important decision in the milestone, and the alternative is genuinely
tempting: running the pipeline in-process would be faster, need no Redis, and give the runner direct
access to every intermediate value. It would also be **measuring a system nobody deploys**. Lease
renewal, reclaim, BullMQ delivery, the sweeper, budget enforcement and crash recovery are the
interesting parts of this project; a harness that bypasses them reports a success rate for a
pipeline rather than for Rivet. Concurrency comes from running more workers, which is also how
production scales, so the harness measures that too.

The corollary is that **the dashboard's job column is a link**. Every number on the evaluation page
resolves to a job id whose full timeline, artifacts, plan, diff and review report are already
browsable at `/jobs/:id`. The evaluation surface stores aggregates and grades; it stores no second
copy of anything the job log already holds.

### 2. Benchmark cases are git-tracked files; the database holds a registry, not the truth

A case lives in `benchmarks/<case-id>/` and is reviewed in pull requests like code:

```text
benchmarks/
  bulk-discount-boundary/
    case.json          # the §24.1 fields
    repo/              # the seed tree, exactly as the agent will find it
    hidden/            # hidden tests, never in `repo/`
```

`benchmark_cases` in Postgres is a **registry** - id, version hash, category, difficulty, the pinned
base commit the builder produced - upserted by the builder so that a stored `evaluation_run` can
name what it ran and detect that the case has since changed. It is the second table in the system
that is a cache rather than a record (the first is `github_installations`), and it says so in its
docblock. Editing a case in the database changes nothing; editing the files and rebuilding does.

The version hash is a SHA-256 over the canonical case JSON plus the seed tree plus the hidden tests.
Two runs of "the same task" that were not the same task is the most embarrassing thing an evaluation
harness can do, and a hash on every row is what makes that a query rather than a memory.

### 3. Fixtures are local bare repositories, and the base commit is deterministic

`pnpm eval:build` walks `benchmarks/`, and for each case writes a bare repository under
`.rivet/benchmarks/<case-id>.git` (gitignored) whose single commit contains `repo/` verbatim. Author
name, email, commit date and committer date are **fixed constants** in the case format, so the
commit SHA is a pure function of the tree. The builder writes that SHA into `case.json`'s lockfile
sibling (`case.lock.json`, git-tracked) and fails loudly if a rebuild produces a different one. That
is §24.2 (pin the repository commit) enforced by construction rather than by discipline.

Local rather than GitHub for four reasons that all matter: it costs nothing, it works offline and in
CI, it cannot rate-limit, and nobody can push to it. A benchmark whose ground truth lives in a repo
a stranger can edit is not a benchmark. The cost is that the harness does not exercise M9's
authenticated clone or publication - which is fine, because `publication.int.test.ts`,
`publication.sbx.test.ts` and `pnpm demo:pr` already do, and an evaluation suite that opened five
pull requests per run against a real repository would be actively unpleasant.

The seed trees are deliberately small and dependency-free in the style of `rivet-fixture-node`:
`node --test`, no `node_modules` to install, scripts that run in a second. Cold `pnpm install` is
the slowest thing in a job and it measures npm, not Rivet.

### 4. The local seed is a **seed source**, not a GitHub special case

`PipelineOptions.github.seedClone` already does the exact host-side work provisioning needs. M10
generalizes the shape rather than duplicating it:

- `packages/core` gains `PipelineOptions.localSeed?: LocalSeed`, typed
  `(input: LocalSeedRequest) => Promise<SeedCloneResult>` - the same result type, no token field.
- `provisioningPhase()` chooses a seed source in one place: a GitHub binding takes the authenticated
  seed; otherwise a job whose `repoUrl` uses the local scheme takes `localSeed`; otherwise the
  existing unauthenticated in-container clone runs, unchanged. Everything downstream - `putArchive`,
  commit resolution, checkpoint restore, install - is untouched, which is the point.
- `apps/worker/src/git/host-git.ts` grows `localSeed()` beside `seedClone()`, sharing the clone,
  checkout, `rev-parse` and tar helpers, including `--no-xattrs` and `COPYFILE_DISABLE=1`. Those two
  flags are load-bearing on macOS and a second archive path that forgot them would fail with
  `sandbox_create_failed` on a repository that is perfectly fine.

`createJobSchema.repoUrl` is https-only today, and that stays true for anything a browser can
submit. The local scheme is `rivet-local:<case-id>` - not `file://`, deliberately, because an opaque
scheme carries no path and therefore cannot be pointed at `/etc` by a crafted request. The worker
resolves the case id against its own benchmark root and refuses anything that escapes it. Accepting
the scheme at all is gated on `RIVET_EVAL=on`, which joins the switch family and is **refused under
`NODE_ENV=production`** for exactly the reason its three siblings are: a production worker that will
run jobs against local fixtures is a production worker that can be told to run something other than
a customer's repository.

### 5. Hidden tests are graded in a **separate container, after the job is over**

This is the second load-bearing decision, and it follows from what the hidden tests are for. §24.3
wants machine-verifiable success; the whole value of a hidden test is that the model could not have
read it, could not have edited it, and could not have satisfied it by accident. Any design that puts
the hidden tests inside the job's own container at any moment risks exactly that - and it would also
put them in the diff, in the checkpoint, and in the pull request.

So grading is its own step, owned by the runner, not by the pipeline:

1. The job reaches a terminal status. The runner reads the job's **last checkpoint** - the lossless
   binary patch against the immutable base commit, with its SHA-256.
2. The runner provisions a fresh sandbox from the same pinned image at the case's base commit, using
   the same local seed, applies the patch, and re-derives it to confirm the checksum agrees. A
   mismatch is `grade_workspace_invalid` and the run is scored as ungraded rather than failed -
   grading a tree that is not the tree the job produced is worse than not grading.
3. It copies `hidden/` in, **overwriting** any path the agent happened to create at the same name,
   and runs the case's `validation_command`.
4. It records the exit code, the parsed test totals, and a bounded transcript.
5. The container is destroyed. Always, on every exit path, the same rule the processor follows.

Two properties fall out of this that are worth stating. The grader never runs against a job that
failed before producing a checkpoint - that run is scored from its status and needs no container.
And grading is **re-runnable**: the patch is in Postgres, the case is in git, so a fixed hidden test
can be re-scored over historical runs months later without re-running a single model call.
`pnpm eval:grade <suite-id>` exists for exactly that.

### 6. Success is a composite, and the primary component is machine-verifiable

§24.3 is explicit that the reviewer's opinion must not be the definition of success. A run's
`result` is one of `passed`, `failed`, `errored`, `ungraded`, decided in this order:

- **`errored`** - the job never reached a state that can be judged: `timed_out`, `budget_exceeded`,
  `cancelled`, or a failure category that is about Rivet or the environment rather than about the
  work (`sandbox_create_failed`, `provider_*`, `checkpoint_*`, `oom_killed`). These are counted, and
  counted separately, because an infrastructure failure rate and a task failure rate are different
  numbers and averaging them together hides both.
- **`ungraded`** - grading itself could not run.
- **`passed`** - the job completed **and** the hidden tests passed **and** the validation report's
  aggregate outcome is not `regressed`.
- **`failed`** - everything else.

`score` (§10.9) is the fraction of hidden test assertions passed, so a near-miss is visible rather
than being flattened to zero. `metrics_json` carries the §24.4 snapshot for that run - runtime,
model calls, tool calls, tokens, cost, review loops, review decision, regressions, files changed,
attempt count - denormalized at grade time so the dashboard is one query and so a later change to
how a metric is computed cannot silently rewrite history.

### 7. Failure labels are derived where that is honest, and manual where it is not

The grader assigns a §24.5 label when the data decides it unambiguously - `Budget exceeded`,
`Environment failure`, `Tool failure`, `Reviewer false positive` (approved, hidden tests failed),
`Agent loop` (turn ceiling with no diff progress). It leaves `null` for the judgement calls -
`Incorrect diagnosis`, `Insufficient context`, `Bad implementation`, `Test misunderstanding` - which
are not machine-decidable and would be quietly wrong if guessed.

`pnpm eval:label` walks unlabeled failures, prints the case, the diff stat, the review verdict and
the hidden-test output, and writes the label. The column records **who** decided (`auto` or
`manual`), because a chart that mixes derived and human labels without saying so is a chart that
overstates its own rigour.

### 8. Repetitions are first-class, because the thing being measured is nondeterministic

Every case runs `N` times per arm, `N = 3` by default, configurable per suite. The store keeps every
individual run; the dashboard reports success as k/N with the spread, never as a single boolean.

This is not fussiness. A five-case suite run once produces a success rate quantized to 20% steps,
and Experiment 1's entire question is whether one arm beats another by a margin distinguishable from
model variance. Single-shot evaluation would let this milestone report a number it cannot defend,
which is a worse outcome than reporting no number. The cost is 3x the model spend on a five-case
suite, which is small precisely because the suite is five cases.

### 9. Experiment 1 is a suite with two arms, and the only thing it varies is one field

An `evaluation_suite` row carries an `arms` array; each arm is a label plus a job-configuration
patch. Experiment 1 is
`[{label: "independent", reviewMode: "independent"}, {label: "none", reviewMode: "none"}]`, and the
runner's inner loop is case x arm x repetition. Nothing about the pipeline knows an experiment is
happening.

That generality is deliberate and cheap: Experiments 2-5 in §25 (planning on/off, context strategy,
model comparison, retry strategy) all become an arms array over fields that already exist on the job
or on the worker config, rather than a new harness each. M10 runs Experiment 1 and leaves the others
documented.

---

## Migration

One migration, three tables, no changes to `jobs`.

```text
benchmark_cases
  id                text primary key        -- the directory name, e.g. bulk-discount-boundary
  version_hash      text not null           -- sha256 over case.json + repo/ + hidden/
  title             text not null
  category          text not null           -- §24.1 task_category, Zod-validated text
  difficulty        integer not null        -- §32 level 1-4
  base_commit_sha   text not null           -- deterministic, from the fixture builder
  spec              jsonb not null          -- the parsed, canonicalized case
  created_at, updated_at

evaluation_suites
  id                uuid primary key
  label             text not null
  arms              jsonb not null          -- [{label, jobPatch}]
  repetitions       integer not null default 3
  case_ids          jsonb not null          -- the cases as of the moment it started
  status            text not null           -- running | completed | aborted
  started_at, completed_at, created_at

evaluation_runs                             -- PRD §10.9
  id                uuid primary key
  suite_id          uuid not null references evaluation_suites(id)
  benchmark_id      text not null references benchmark_cases(id)
  case_version_hash text not null           -- what actually ran, not what is on disk now
  arm               text not null
  repetition        integer not null
  job_id            uuid references jobs(id)      -- null only if creation itself failed
  result            text not null           -- passed | failed | errored | ungraded
  score             numeric(5,4)
  failure_category  text                    -- §24.5 label
  failure_label_source text                 -- auto | manual
  metrics_json      jsonb not null
  graded_at         timestamptz
  created_at
  unique (suite_id, benchmark_id, arm, repetition)
```

Three notes on shape. `evaluation_runs.job_id` is nullable and is the only foreign key into `jobs`
anywhere in the schema - the direction matters, because a job must remain a complete, self-contained
record whether or not an evaluation ever referenced it. `case_version_hash` is copied onto the run
rather than joined from the case, so a rebuilt case cannot retroactively relabel old results.
`arms`, `case_ids` and `metrics_json` are `jsonb` validated by Zod in `@rivet/contracts`, following
the same rule `failure_category` and the event vocabulary follow: this vocabulary will churn, and a
migration per new metric buys nothing.

Everything is append-only except `benchmark_cases` (a cache, so it upserts) and
`evaluation_suites.status` / `evaluation_runs` grading columns, which are written once by the runner
that owns the row. There is no lease here and there does not need to be one: the runner is a CLI a
person started, not a distributed worker.

---

## The case format

```json
{
  "id": "bulk-discount-boundary",
  "title": "Fix the bulk discount boundary",
  "category": "bug_fix",
  "difficulty": 1,
  "issue": "The fixture says that 10 items or more qualify...",
  "setupCommand": null,
  "validationCommand": ["node", "--test", "hidden/"],
  "expectedBehavior": "qualifiesForBulkDiscount(10) is true and the public suite stays green.",
  "reviewMode": "independent",
  "maxCostUsd": "1.00",
  "maxDurationSeconds": 900,
  "commit": { "author": "Rivet Benchmarks", "email": "...", "date": "2020-01-01T00:00:00Z" }
}
```

Strict Zod, no unknown keys, in `packages/contracts/src/benchmark-case.ts`. `validationCommand` is a
non-empty argv array, never a shell string - the same rule `rivet.json` follows and for the same
reason. `setupCommand` is nullable and runs in the grading container before the hidden tests, for
cases that need a fixture built. The budget fields exist because a benchmark case whose cost ceiling
is whatever the worker's default happens to be is not reproducible.

### The first five cases

Chosen to cover §24.1's categories and §32's difficulty ladder, and - more importantly - to make
each part of the harness fail if it is broken:

| id                       | category   | level | what it proves                                                       |
| ------------------------ | ---------- | ----- | -------------------------------------------------------------------- |
| `bulk-discount-boundary` | bug fix    | 1     | The happy path. A named test, a one-line fix, hidden tests pass.     |
| `stale-cache-key`        | bug fix    | 2     | Requires search: the bug is not where the symptom is.                |
| `multi-line-order`       | feature    | 3     | Public tests go green while hidden tests catch the rounding rule.    |
| `extract-pricing-module` | refactor   | 3     | Behaviour must not change; hidden tests are the existing behaviour.  |
| `paginate-list-endpoint` | API change | 4     | Multi-file, with a hidden test for the contract the issue described. |

`bulk-discount-boundary` and `multi-line-order` are ported from `demo-tasks.ts`, which is where the
seed tree for both already effectively lives. Once the benchmark format exists, `demo-tasks.ts`
becomes a thin re-export of two benchmark cases rather than a second place tasks are written down.

---

## Vocabulary additions

- **Failure categories** (`packages/contracts/src/job-event.ts`): none. M10 adds no way for a _job_
  to fail. Grading failures are the runner's vocabulary, not the job's.
- **Job event types**: none, for the same reason. A job under evaluation is an ordinary job and its
  timeline must stay identical, or the harness is measuring a different system than production runs.
- **New contracts**: `benchmarkCaseSchema`, `evaluationSuiteSchema`, `evaluationRunSchema`,
  `runResultSchema`, `failureLabelSchema` (§24.5), `runMetricsSchema` (§24.4).
- **New env**: `RIVET_EVAL` (`on` | `off`, default `off`, refused under `NODE_ENV=production`),
  `RIVET_BENCHMARK_ROOT` (default `<repo>/benchmarks`), `RIVET_EVAL_CONCURRENCY` (how many jobs the
  runner keeps in flight, default 1).

---

## Stage 0 - the acceptance contract

Write `docs/plans/milestone-10-acceptance.md` first, the way M8 and M9 did. Runs A-H, each naming
the exact assertion:

- **A** - the fixture builder is deterministic: build twice, same commit SHA, same version hash.
- **B** - a job created against `rivet-local:<case>` provisions, and the container's tree matches
  the seed tree byte for byte, with no `._*` sidecars and no untracked files.
- **C** - the hidden tests are absent from the job's container, from every command transcript, from
  the diff artifact and from the checkpoint patch. A grep for a sentinel string in `hidden/`, across
  the container, every command row, every event row and every artifact.
- **D** - a scripted-agent run that produces the known-good diff grades `passed`; one that produces
  a diff satisfying the public tests but not the hidden ones grades `failed` with a non-zero score.
- **E** - a job that never checkpoints grades `errored`, not `ungraded`, and never provisions a
  grading container.
- **F** - a tampered checkpoint grades `ungraded` and the run is excluded from the success rate.
- **G** - metrics: an evaluation run's `metrics_json` agrees with the job row and the validation
  report it was derived from, field by field.
- **H** - a two-arm, two-repetition suite over two cases produces exactly eight runs, eight jobs,
  and a dashboard whose aggregates match a hand-computed table.

A-G run under `RIVET_AGENT=scripted`, need no model key, and belong in CI. H is the local
demonstration and is what `pnpm demo:eval` performs.

## Stage 1 - contracts

`packages/contracts`: the case, suite, run, result, metric and label schemas, with tests for the
strictness rules (unknown keys rejected, argv arrays non-empty, difficulty bounded, category in the
§24.1 set). No dependency on anything else in the milestone, so this lands first and alone.

## Stage 2 - database

The three tables, `pnpm db:generate`, commit the generated SQL, `pnpm db:migrate`. Single-writer
modules in `packages/core/src/evaluation/`: `case-store.ts` (upsert, the cache), `suite-store.ts`,
`run-store.ts`. Same shape as every other store here - an input object, an optional `Executor`, Zod
at the boundary. Add the `evaluation/` directory to the list in AGENTS.md's "every module lives
under" invariant.

## Stage 3 - the fixture format and builder

`packages/benchmarks` - or, if it stays this small, `packages/core/src/evaluation/case-loader.ts`
plus a script; decide when the loader is written and do not create a package for one file. Reads
`benchmarks/`, validates each `case.json`, computes the version hash, and builds the bare repos with
fixed commit metadata. `pnpm eval:build`. Determinism is asserted in a unit test (run A).

## Stage 4 - the first five seed trees

Author `repo/` and `hidden/` for the five cases. This is the slowest stage and it is content, not
code. Each seed tree gets its own public test suite that is _incomplete_ in a specific, documented
way, and hidden tests that close exactly that gap. Write the `expectedBehavior` sentence before the
hidden test, not after - it is the thing the hidden test is supposed to encode.

## Stage 5 - the local seed source

`LocalSeed` in `packages/core`, the seed-source selection in `provisioningPhase()`, `localSeed()` in
`apps/worker/src/git/host-git.ts`, the `rivet-local:` scheme in contracts with its path-escape
refusal, `RIVET_EVAL` in `parseWorkerConfig` with the production refusal and its unit test. Run B
lands here.

## Stage 6 - the grader

`packages/core/src/evaluation/grader.ts`: read the last checkpoint, provision, seed, apply, verify
the SHA-256, copy `hidden/`, run `setupCommand` then `validationCommand`, parse totals, destroy the
container in a `finally`. It takes the `Sandbox` port, not dockerode. Runs C-F land here.

## Stage 7 - the runner CLI

`apps/worker/src/eval-run.ts`, `pnpm eval:run`. Resolves the suite (cases x arms x repetitions),
creates each job with the arm's patch and the case's budgets, enqueues it, waits on terminal status
with the same polling shape `job-demo.ts` already uses, grades, computes metrics, writes the run
row. `RIVET_EVAL_CONCURRENCY` bounds jobs in flight. `--dry-run` prints the matrix without spending
anything, and should be the first thing anyone runs. Sibling commands: `pnpm eval:grade <suite>`
(re-grade from stored patches) and `pnpm eval:label` (Decision 7). Run G lands here.

## Stage 8 - the web surface

`/evaluations` and `/evaluations/:id`, server components, `force-dynamic`, no new dependency: a
suite list, a per-suite table of case x arm with k/N and spread, the §24.4 aggregates, a failure
histogram by §24.5 label, and every run linking to its job. Read routes `GET /api/evaluations/:id`,
`GET /api/benchmarks`, `GET /api/benchmarks/:id/results` per §19. `POST /api/evaluations` is
**deliberately not built** - the runner is a CLI in this milestone, and an HTTP endpoint that starts
a paid multi-hour matrix with no auth in front of it is the wrong thing to add to a single-owner app
(see `SECURITY.md`). Charts are M12's line item; M10 ships correct numbers in tables.

## Stage 9 - Experiment 1

Run the five cases x two arms x three repetitions with a real model. Record the cost before starting
and check it against the budget. Write the result up in `docs/experiments/reviewer-value.md` with
the raw suite id, the per-case table, the aggregate delta, and an honest paragraph about what a
30-run sample can and cannot support. Link it from the README, per §25.

## Stage 10 - verification and documentation

`pnpm test`, `test:integration`, `test:sandbox`, `test:streaming`, `lint`, `typecheck`,
`format:check`, `build` with no database. `pnpm demo:eval` (run H). Then
`docs/milestone-10-guide.md` and the AGENTS.md paragraph, which is the artifact the next agent
actually reads.

---

## Definition of done

- `pnpm eval:build` produces five bare repositories with commit SHAs that match `case.lock.json`.
- `pnpm eval:run --dry-run` prints a 30-run matrix; `pnpm eval:run` executes it against real
  workers.
- Every run has a job whose timeline is indistinguishable from an ordinary job's.
- Hidden tests are provably absent from every job container, transcript, event, artifact and patch.
- `pnpm eval:grade` re-scores a completed suite with no model calls.
- `/evaluations/:id` shows success by case, by arm and by category, with §24.4 efficiency and
  quality aggregates and a §24.5 failure histogram.
- Experiment 1 is run and written up.
- Runs A-G pass in CI with no model key; run H passes locally against Docker.
- The PRD's "expand to 20" and "eventually 30-50" entries stay unchecked, with the reason recorded.

---

## Risks and deliberate limits

**A five-case, three-repetition suite cannot settle Experiment 1.** Thirty runs per arm is enough to
see a large effect and nowhere near enough to see a small one. The write-up must say so in plain
language; a confident claim from this sample size would undermine exactly the credibility the
evaluation framework exists to build.

**Local fixtures are not real repositories.** They are small, dependency-free and authored by the
same person who wrote the agent's prompts, which is a bias no amount of statistics removes. That is
the correct trade for M10 - reproducibility first - but the honest next step is a handful of pinned
real-world commits, and it belongs on the roadmap rather than in this milestone.

**Hidden tests can be wrong.** A hidden test that encodes the author's assumption rather than the
issue's requirement scores a correct solution as a failure, and the harness will report it with a
straight face. This is what `pnpm eval:grade`'s re-runnability is for: fix the test, re-score the
history, and note the correction in the suite record.

**Grading costs a container per run.** Thirty runs is thirty extra provisions. Dependency-free seed
trees keep that to seconds each, and it is the price of grading a tree the model never saw the tests
for.

**`RIVET_EVAL=on` widens what a worker will clone.** It is refused under `NODE_ENV=production`, the
scheme is opaque and resolved against a configured root, and path escape is rejected - but it is a
new input surface on the worker and it is listed here so the M11 security review looks at it.
