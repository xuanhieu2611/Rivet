# Milestone 10: a guided tour of the evaluation harness

This is the educational record for Milestone 10. The plan in
[`docs/plans/milestone-10.md`](plans/milestone-10.md) describes the intended design, the acceptance
contract in [`docs/plans/milestone-10-acceptance.md`](plans/milestone-10-acceptance.md) describes
the observable behaviour, and [`docs/experiments/reviewer-value.md`](experiments/reviewer-value.md)
is the milestone's first result. This guide explains how the implementation fulfils that design, why
the important decisions were made, how to trace an evaluation run through the system, and where to
look when a number looks wrong.

**Status: implementation complete.** Contracts, the three tables, the fixture builder, five
benchmark cases, the local seed source, the grader, the runner CLI, the web surface and Experiment 1
have all landed. Acceptance runs A through G pass with no model key and no network; run H is
`pnpm demo:eval` against Docker and a real model.

---

## Part 0. The one idea

Every milestone before this one answers **"did this job work?"** Milestone 10 answers **"how often
does this system work, on what kind of task, at what cost, and where does it fail?"**

That is a different kind of engineering, and it has a different failure mode. M9's risk was loud: a
duplicate pull request, a leaked token, a push that happened twice. M10's risk is quiet:

> An evaluation harness fails by producing a number that is wrong in a way nobody notices.

A hidden test that leaked into the model's context. A grader that scored a tree the job did not
produce. A Docker outage averaged into a task success rate. Two runs of "the same case" that were
not the same case. Each of those produces a clean-looking table and a defensible paragraph, and each
is worse than a harness that visibly crashes.

So almost every design decision in this milestone is a **negative** one - something the harness
refuses to do:

1. It refuses to run the pipeline in-process. An evaluation run **is** a job, created with
   `createJob()` and executed by a real worker under a real Postgres lease.
2. It refuses to let hidden tests near the job. Grading happens in a **second container, after the
   job is over**, seeded from the job's last checkpoint.
3. It refuses to score a workspace it cannot prove is the job's. The checkpoint patch is applied,
   re-derived and SHA-256 compared before `hidden/` is copied in.
4. It refuses to fold infrastructure failures into the success rate. `errored` and `ungraded` are
   counted, reported, and excluded from the denominator.
5. It refuses to guess a failure label it cannot derive. Every row records whether a human or the
   classifier decided.
6. It refuses to add a job event, a job status or a failure category. A job under evaluation must be
   indistinguishable from a job created in the web form, or the harness is measuring a different
   system than the one that runs in production.

---

## Part 1. What changed from M9

### Before M10

A job existed because a person created it. It ran once, ended in a pull request, and its record was
a timeline nobody aggregated. There was no way to ask "does Rivet solve refactors more often than
bug fixes", and no way to answer "is the independent reviewer worth what it costs" other than by
opinion.

### After M10

```text
benchmarks/<case-id>/            git-tracked case: case.json, case.lock.json, repo/, hidden/
        |
        | pnpm eval:build           deterministic, fixed commit metadata
        v
.rivet/benchmarks/<case-id>.git  a local bare repository, gitignored
        |
        | rivet-local:<case-id>     an opaque URL on an ordinary job row
        v
the unchanged pipeline           provisioning ... finalizing, one job per (case, arm, repetition)
        |
        | the job's last checkpoint
        v
the grader                       a second container: apply, re-derive, compare, copy hidden/, run
        |
        v
evaluation_runs                  result, score, failure label, an immutable metric snapshot
        |
        v
/evaluations/:id                 success by case, arm and category, §24.4 aggregates, §24.5 histogram
```

### New durable vocabulary

| Kind                   | Added                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Tables                 | `benchmark_cases`, `evaluation_suites`, `evaluation_runs`                            |
| Contracts              | `benchmarkCaseSchema`, `evaluationSuiteSchema`, `evaluationRunSchema`                |
|                        | `runResultSchema`, `failureLabelSchema`, `runMetricsSchema`                          |
| Run results            | `passed`, `failed`, `errored`, `ungraded`                                            |
| Grading category       | `grade_workspace_invalid` (the runner's vocabulary, never the job's)                 |
| Repo URL scheme        | `rivet-local:<case-id>`                                                              |
| Environment            | `RIVET_EVAL`, `RIVET_BENCHMARK_ROOT`, `RIVET_BENCHMARK_FIXTURE_ROOT`                 |
|                        | `RIVET_EVAL_CLONE_TIMEOUT_MS`, `RIVET_EVAL_SEED_MAX_BYTES`, `RIVET_EVAL_CONCURRENCY` |
| Job event types        | **none**                                                                             |
| Job failure categories | **none**                                                                             |
| Job statuses           | **none**                                                                             |

The last three rows are the milestone's central claim, and acceptance run C asserts them rather than
stating them.

---

## Part 2. The implementation history

Ten stages, in dependency order, each landed on its own.

| Stage | Commit    | What landed                                                   |
| ----- | --------- | ------------------------------------------------------------- |
| 0     | `9c50e63` | The plan and the acceptance contract, written before any code |
| 1     | `f61518b` | Contracts: case, suite, run, result, metrics, label schemas   |
| 2     | `b7ff091` | The three tables and their single-writer stores               |
| 3     | `d50d248` | The case loader, the version hash and the fixture builder     |
| 4     | `78c319b` | The five benchmark cases: `repo/`, `hidden/`, lockfiles       |
| 5     | `fca9a58` | The local seed source and the `rivet-local:` scheme           |
| 6     | `f06749f` | The grader                                                    |
| 7     | `9dd5c8a` | The runner CLI: `eval:run`, `eval:grade`, `eval:label`        |
| 8     | `ef52271` | `/evaluations`, `/evaluations/:id`, the three read routes     |
| 9     | `af2500a` | Experiment 1, run and written up                              |
| 10    | this one  | Acceptance runs A-H, the verification sweep and this guide    |

Stage 0 first is not ceremony. The acceptance contract is where "an `errored` classification must be
exhaustive over `FAILURE_CATEGORIES` at compile time" and "the grader takes the provider, not a live
container" were decided, and both are cheaper to decide before Stage 6 than to discover during it.

---

## Part 3. Recommended reading path

```text
packages/contracts/src/benchmark-case.ts      the case, and the two closed vocabularies
packages/contracts/src/evaluation-run.ts      results, metrics, labels, and their cross-field rules
packages/core/src/evaluation/case-loader.ts   loading, hashing and building the fixtures
packages/core/src/evaluation/local-seed.ts    resolving rivet-local: below a root
packages/core/src/pipeline/provisioning-phase.ts   the one place a seed source is chosen
packages/core/src/evaluation/grader.ts        the second container, in order
packages/core/src/evaluation/run-classification.ts   errored vs task, and the auto labels
packages/core/src/evaluation/aggregate.ts     everything /evaluations/:id renders
apps/worker/src/eval-run.ts                   the matrix, the wait, grading, the metric snapshot
apps/worker/src/eval.ts                       the worker's half of RIVET_EVAL
apps/web/app/evaluations/[id]/page.tsx        the numbers, in tables
```

Then the acceptance runs, which are the shortest description of what the system promises:

```text
apps/worker/tests/integration/evaluation.int.test.ts   runs E and G
apps/worker/tests/sandbox/evaluation.sbx.test.ts       runs C, D and F
apps/worker/tests/sandbox/local-seed.sbx.test.ts       run B
packages/core/src/evaluation/case-loader.test.ts       run A, against synthetic cases
apps/worker/src/eval-corpus.test.ts                    run A, against the real corpus
```

---

## Part 4. An evaluation run is a job

The runner does not call `buildPipeline()`. It calls `createJob()` and `requestJobRun()`, exactly
like the web app does, and a real worker claims the row under a real Postgres lease.

The alternative was genuinely tempting. Running the pipeline in-process would be faster, would need
no Redis, and would give the runner direct access to every intermediate value. It would also be
**measuring a system nobody deploys**. Lease renewal, reclaim, BullMQ delivery, the sweeper, budget
enforcement and crash recovery are the interesting parts of this project; a harness that bypasses
them reports a success rate for a pipeline rather than for Rivet.

Two consequences follow, and both are visible in the code:

- **Concurrency comes from more workers.** `RIVET_EVAL_CONCURRENCY` bounds jobs in flight and is
  passed to the spawned worker as `WORKER_CONCURRENCY`, which is also how production scales.
- **The dashboard's job column is a link.** Every number on `/evaluations/:id` resolves to a job id
  whose timeline, artifacts, plan, diff, validation report and review report were already browsable
  at `/jobs/:id` before this milestone existed. The evaluation surface stores aggregates and grades.
  It stores no second copy of anything the job log already holds.

`runEvaluationCell()` in `apps/worker/src/eval-run.ts` is the whole loop: create the job with the
arm's patch and the case's budgets, enqueue it, wait for a terminal status, grade, snapshot the
metrics, write one `evaluation_runs` row.

---

## Part 5. The case format and the fixture builder

### A case is files, not a row

```text
benchmarks/bulk-discount-boundary/
  case.json          the §24.1 fields, strict Zod, no unknown keys
  case.lock.json     { versionHash, baseCommitSha } - git-tracked, written by the builder
  repo/              the seed tree, exactly as the agent will find it
  hidden/            hidden tests, never in repo/, never in the job's container
```

`benchmark_cases` in Postgres is a **registry**, not the truth. It is the second table in the system
that is a cache rather than a record - the first is `github_installations` - and it says so in its
docblock. Editing a row changes nothing; editing the files and running `pnpm eval:build` does.

### The two closed vocabularies

`category` is §24.1's seven, in snake_case: `bug_fix`, `feature`, `refactor`, `test_generation`,
`concurrency`, `api_change`, `database_change`. `difficulty` is an integer 1 through 6, which is
§32's full ladder. The five authored cases use levels 1 through 4; that is a fact about the corpus,
not about the schema, and a schema that refused a level 5 case would have to be migrated by the
first person who wrote one.

### Determinism, and why it is enforced rather than trusted

`pnpm eval:build` writes `.rivet/benchmarks/<case-id>.git`, a bare repository whose single root
commit contains `repo/` verbatim. Author, email, and both timestamps come from `case.json`'s
`commit` block, so the commit SHA is a pure function of the tree. The builder then compares that SHA
against `case.lock.json` and fails loudly, naming both SHAs, when they differ.

The version hash is SHA-256 over the canonical case JSON plus `repo/` plus `hidden/`, and it is
copied onto every `evaluation_runs` row rather than joined from the case. Two runs of "the same
task" that were not the same task is the most embarrassing thing an evaluation harness can do, and a
hash on every row makes that a query rather than a memory.

Run A asserts all of it, including the part that will actually happen to somebody: building under a
different `TZ` and a different `git config user.name` produces the same SHA. It also asserts the
asymmetry that makes hidden tests work - changing a byte under `repo/` changes both the version hash
and the commit; changing a byte under `hidden/` changes **only** the version hash, because the
hidden tests are part of the case's identity and are not part of the seeded repository.

### Why local bare repositories rather than GitHub

Four reasons that all matter: it costs nothing, it works offline and in CI, it cannot be
rate-limited, and nobody can push to it. A benchmark whose ground truth lives in a repository a
stranger can edit is not a benchmark. The cost is that the harness does not exercise M9's
authenticated clone or publication, which is fine, because `publication.int.test.ts`,
`publication.sbx.test.ts` and `pnpm demo:pr` already do - and a suite that opened thirty pull
requests per run would be actively unpleasant.

---

## Part 6. The local seed, and one archive path

M9 taught provisioning that a repository can arrive as an archive the worker host built rather than
as a clone the container performed. That shape - "hand me a tar of a checked-out repository and the
commit it holds" - has nothing to do with GitHub. A benchmark case is the same operation with a
different remote and no credential at all.

So M10 added a second **source**, not a second branch inside the GitHub one:

- `packages/core` gained `PipelineOptions.localSeed`, typed
  `(input: LocalSeedRequest) => Promise<SeedCloneResult>` - the same result type as `seedClone`, and
  deliberately with no token field. A seed source that cannot carry a credential cannot leak one.
- `provisioningPhase()` chooses in exactly one place: a GitHub binding takes the authenticated seed;
  otherwise a `rivet-local:` URL takes `localSeed`; otherwise the unauthenticated in-container clone
  runs, unchanged. Everything downstream reads a `SeedCloneResult` that cannot say which one
  produced it, which is what makes an evaluation job's timeline identical to an ordinary job's.
- `apps/worker/src/git/host-git.ts` gained `localSeed()` **beside** `seedClone()`, sharing
  `archiveRepository()` - `--no-xattrs` and `COPYFILE_DISABLE=1` included. A second archive path
  that forgot either flag would fail on macOS as `sandbox_create_failed` on a repository that is
  perfectly fine, or quietly deliver a container full of AppleDouble sidecars Rivet invented.

### The scheme is opaque on purpose

`rivet-local:<case-id>` is not `file:///...`, and that is the entire security argument. A
path-carrying scheme would put every acceptor one crafted request away from cloning `/etc`, and the
refusal would have to be written correctly in each of them. The identifier is constrained by
`benchmarkIdSchema` to lowercase kebab-case, which cannot express a separator, a parent segment or
an absolute root, so `../../etc`, `/etc/passwd` and `a/../../b` are rejected by the parser with no
filesystem involved. `resolveBenchmarkRepositoryPath()` then resolves the id below the fixture root
and compares `realpath`s, which is the check that still holds when the attacker controls the fixture
directory rather than the URL.

Three more refusals complete the surface:

- `createJobSchema.repoUrl` stays https-only, so nothing a browser can submit reaches the scheme.
- Without `RIVET_EVAL=on` the worker has no `localSeed`, and such a job fails `repo_unavailable`
  with a stated reason rather than falling through to a clone that cannot work.
- `parseWorkerConfig` refuses `RIVET_EVAL=on` under `NODE_ENV=production`, the same rule its three
  siblings follow: a production worker that will run jobs against local fixtures is a production
  worker that can be told to run something other than a customer's repository.

---

## Part 7. The grader

`gradeEvaluationRun()` in `packages/core/src/evaluation/grader.ts` takes the `SandboxProvider`
**port**, not dockerode and not a live container, and it writes nothing anywhere.

### The order is the contract

```text
1. classify from the job row
     infrastructure outcome -> errored, right here, with no container and no checkpoint read
2. read the job's last checkpoint          (lazy: an errored job never even reads it)
3. seed the case at the checkpoint's base commit, and compare the commit
4. create the grading container on the same pinned image the job ran on
5. upload the seed, apply the patch, re-derive it, compare SHA-256 and byte length
6. rm -rf hidden/, then write the case's own hidden files
7. run setupCommand, then validationCommand
8. parse the totals, decide passed or failed
9. destroy the container - in a `finally`, on every path
```

Step 1 costs nothing and saves a container per infrastructure failure, which matters because
infrastructure failures arrive in bursts. Step 3's commit comparison is not ceremony: a patch cut
against one benchmark's base commit will often apply cleanly to another's, and the difference would
otherwise show up only as a mysteriously low score. Step 5 before step 6 is the whole design - the
checksum is compared while the tree is still exactly what the job produced, because grading a tree
that is not the job's tree is worse than not grading. And step 6 removes the directory rather than
merging into it, because a session that invented a file under `hidden/` would otherwise have it
collected by a validation command that names the directory, which is a model writing its own
benchmark and passing it.

### Grading is re-runnable

The patch is in Postgres and the case is in git, so a corrected hidden test can re-score historical
runs months later without a single model call. That is what `pnpm eval:grade <suite-id>` is for, and
it is also the answer to the milestone's most uncomfortable risk: **hidden tests can be wrong**. A
hidden test that encodes the author's assumption rather than the issue's requirement scores a
correct solution as a failure, and the harness will report it with a straight face. Fix the test,
re-score the history, note the correction.

---

## Part 8. Classification, and honest labels

### Four results, decided in order

| Result     | When                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `errored`  | The job never reached a judgeable state: timeout, budget, cancellation, or an infrastructure failure category                     |
| `ungraded` | Grading itself could not run: a corrupt or unappliable patch, a checksum disagreement, a wrong-case seed, a failed `setupCommand` |
| `passed`   | The job completed, the hidden tests passed, and the validation aggregate is not `regressed`                                       |
| `failed`   | Everything else                                                                                                                   |

`EVALUATION_FAILURE_CLASSES` in `run-classification.ts` is a total
`Record<FailureCategory, "infrastructure" | "task">`, not an array of the interesting ones. A
category added in M11 fails `pnpm typecheck` until somebody decides which side of the success rate
it belongs on. That is probably the single assertion in this milestone most likely to be worth its
weight in two milestones' time.

`errored` and `ungraded` are counted, shown, and **excluded from the denominator**. Success rate is
computed over `passed + failed` only. An infrastructure failure rate and a task failure rate are
different numbers, and averaging them together hides both.

`score` is the fraction of hidden assertions passed, rounded to the stored `numeric(5,4)` scale, so
a run that passes 7 of 8 is a `failed` run with a score of `0.8750` rather than a zero. Flattening
that would hide the difference between a near miss and a model that did nothing.

### Labels say who decided

The classifier assigns a §24.5 label only where the data decides it unambiguously:

```text
budget_exceeded, terminal                     -> "Budget exceeded"        auto
sandbox_* / repo_unavailable / oom_killed     -> "Environment failure"    auto
agent_failed with a tool assertion failure    -> "Tool failure"           auto
review approved AND the run failed            -> "Reviewer false positive" auto
the turn ceiling reached with no diff growth  -> "Agent loop"             auto
everything else that failed                   -> null                     no source
```

`Incorrect diagnosis`, `Insufficient context`, `Bad implementation` and `Test misunderstanding` are
not machine-decidable, and a classifier that guessed them would produce a failure histogram that
looks rigorous and is fiction. `pnpm eval:label` walks the unlabelled failures, prints the case, the
diff stat, the review verdict and the hidden-test output, and writes a label with
`failure_label_source = "manual"`; it never overwrites an `auto` label without `--force`. The
dashboard shows the unlabelled bucket rather than hiding it.

---

## Part 9. The metric snapshot

`metrics_json` is denormalized at grade time, from the job row and the `validation_report` and
`diff_stat` artifacts:

```text
runtimeSeconds        completed_at - started_at, null if either is null
totalModelCalls       jobs.total_model_calls
totalToolCalls        jobs.total_tool_calls
totalTurns            jobs.total_turns
totalInputTokens      jobs.total_input_tokens
totalOutputTokens     jobs.total_output_tokens
totalCostUsd          jobs.total_cost_usd, as a string
attemptCount          jobs.attempt_count
reviewLoops           jobs.review_loops
reviewDecision        jobs.review_decision, null when review was skipped
reviewBlockingCount   jobs.review_blocking_count, null when there was no decision
validationOutcome     validation_report.outcome
newFailureCount       sum of newFailures over binding checks
fixedFailureCount     sum of fixedFailures over binding checks
filesChanged / insertions / deletions        diff_stat
hiddenTestsTotal / hiddenTestsPassed         the grading run's parsed totals
```

Three properties are asserted rather than assumed, all in run G:

- **`totalCostUsd` stays a string** the whole way through, because the column is `numeric(10,4)` and
  the one thing an evaluation harness must not do is report a cost that a float rounded.
- **`reviewDecision` is null when review was skipped.** "No reviewer looked at this" and "a reviewer
  had nothing to say" stay different facts; an arm labelled `none` in Experiment 1 that reported a
  decision would invalidate the experiment.
- **The snapshot is immutable.** Change the job's `total_cost_usd` after grading and re-read the run
  row: `metrics_json` does not move. History that a later write can rewrite is not history.

---

## Part 10. The database

One migration, three tables, no change to `jobs`.

```text
benchmark_cases     id, version_hash, title, category, difficulty, base_commit_sha, spec, timestamps
evaluation_suites   id, label, arms, repetitions, case_ids, status, started_at, completed_at
evaluation_runs     id, suite_id, benchmark_id, case_version_hash, arm, repetition, job_id,
                    result, score, failure_category, failure_label_source, metrics_json, graded_at
                    unique (suite_id, benchmark_id, arm, repetition)
```

Single writers, as everywhere else here: `case-store.ts`, `suite-store.ts`, `run-store.ts`. Two
details are worth stating out loud.

**`evaluation_runs.job_id` is the only foreign key into `jobs` anywhere in the schema, and the
direction matters.** A job must remain a complete, self-contained record whether or not an
evaluation ever referenced it. It is nullable because a cell whose job creation itself failed still
gets a row - a missing row would be indistinguishable from a matrix that never ran.

**Grading never writes to `jobs` or `job_events`.** `evaluation_runs` is the evaluation harness's
only writable surface on a completed job, and it does not even live in the same table. Run F asserts
the failing path: after a grading failure the job row is still `completed` and its timeline is byte
for byte the list it was before.

---

## Part 11. The runner CLI

```bash
pnpm eval:build                  # build every case to .rivet/benchmarks, verifying its lockfile
pnpm eval:run --dry-run          # print the matrix; no Postgres, no Redis, no Docker, no spend
pnpm eval:run                    # execute the matrix against real workers
pnpm eval:grade <suite-id>       # re-score a completed suite from stored patches, no model calls
pnpm eval:label --suite <id>     # walk the unlabelled failures and record a human judgement
pnpm demo:eval                   # run H: 2 cases x 2 arms x 2 repetitions, real Docker, real model
```

`pnpm eval:run` flags: `--suite-file`, `--cases`, `--label`, `--repetitions`, `--concurrency`,
`--wait-timeout-ms`, `--no-worker`, `--demo`.

Four things in the runner are load-bearing:

- **`--dry-run` is provably free.** It resolves cases, expands the matrix and prints it, and it
  opens no database connection, enqueues no message and starts no container. That is the command
  anybody runs before spending money, and Experiment 1's write-up records running it first.
- **Reproducibility is checked before spend.** `prepareEvaluationCases()` refuses a case with no
  lockfile, and refuses one whose files no longer hash to what was built, before a single job row
  exists. `pnpm eval:grade` passes `allowVersionMismatch` deliberately, because re-scoring with a
  corrected hidden test is its whole purpose - and it records the **new** hash on the row it
  rewrites.
- **The wait cannot hang forever.** `waitForTerminal()` polls Postgres with a bound derived from the
  job's own `maxDurationSeconds`, and also gives up if the spawned worker exited. A stuck job is
  cancelled, scored `errored`, and the matrix continues; one bad cell must not block twenty-nine
  good ones.
- **A suite is `completed` only when every cell has a terminal row.** An interruption leaves the
  suite `aborted`, which is visible on the dashboard, rather than quietly successful.

Repetitions are first-class because the thing being measured is nondeterministic. `N = 3` by
default; the store keeps every individual run and the dashboard reports k/N with the spread, never a
single boolean. A five-case suite run once would quantize the success rate to 20% steps, and
Experiment 1's entire question is whether one arm beats another by a margin distinguishable from
model variance.

---

## Part 12. The web surface

Server components, `force-dynamic`, no new dependency, no charts (those are M12).

```text
/evaluations           suite list: label, status, arms, repetitions, cases, counts
/evaluations/:id       the numbers - see below
GET /api/evaluations/:id          the suite, its runs and the computed summary
GET /api/benchmarks               the registry snapshot
GET /api/benchmarks/:id/results   every run of one case, across suites
```

`/evaluations/:id` renders success overall and by arm, case and category; the case x arm matrix with
k/N and the score spread; the §24.4 efficiency aggregates (median and mean runtime, total and mean
cost, model calls, tool calls, tokens, attempts); the §24.4 quality aggregates (regressions, new and
fixed failures, mean diff size, review outcomes, hidden-test totals); the §24.5 failure histogram
**including the unlabelled bucket**; and one row per run, each linking to `/jobs/<id>`.

`POST /api/evaluations` is deliberately **not** built. The runner is a CLI in this milestone, and an
HTTP endpoint that starts a paid multi-hour matrix with no authentication in front of it is the
wrong thing to add to a single-owner app. See `SECURITY.md`.

---

## Part 13. Configuration

| Variable                       | Default             | Meaning                                                                        |
| ------------------------------ | ------------------- | ------------------------------------------------------------------------------ |
| `RIVET_EVAL`                   | `off`               | `on` gives the worker a local seed source. Refused under `NODE_ENV=production` |
| `RIVET_BENCHMARK_ROOT`         | `benchmarks`        | The git-tracked cases                                                          |
| `RIVET_BENCHMARK_FIXTURE_ROOT` | `.rivet/benchmarks` | The built bare repositories, gitignored                                        |
| `RIVET_EVAL_CLONE_TIMEOUT_MS`  | `180000`            | Host clone and archive budget for a local seed                                 |
| `RIVET_EVAL_SEED_MAX_BYTES`    | `268435456`         | Complete seed-archive bound                                                    |
| `RIVET_EVAL_CONCURRENCY`       | `1`                 | Jobs the runner keeps in flight                                                |

Relative roots resolve against the repository root found by `findRepositoryRoot()`, never against
`process.cwd()`, so the builder and the worker cannot disagree about which directories these are.

`RIVET_EVAL` is the fourth member of the `RIVET_SANDBOX` / `RIVET_AGENT` / `RIVET_GITHUB` family and
the only one that **widens** what a worker will run against, which is why it is listed here for the
M11 security review.

---

## Part 14. The acceptance runs

| Run | Where                                                                                                 | What it proves                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `packages/core/src/evaluation/case-loader.test.ts`, `apps/worker/src/eval-corpus.test.ts`             | The builder is deterministic and the corpus matches its lockfiles                                                                                         |
| B   | `apps/worker/tests/sandbox/local-seed.sbx.test.ts`                                                    | A seeded container's tree is the case's tree, byte for byte, and its timeline equals an ordinary job's                                                    |
| C   | `apps/worker/tests/sandbox/evaluation.sbx.test.ts`                                                    | The sentinel is in no container, transcript, event, artifact or patch - with positive controls                                                            |
| D   | `apps/worker/tests/sandbox/evaluation.sbx.test.ts`, and the re-grade case in `evaluation.int.test.ts` | The grader discriminates: good diff `passed` 1.0, public-only diff `failed` between 0 and 1, and `eval:grade` reproduces both with no worker and no model |
| E   | `apps/worker/tests/integration/evaluation.int.test.ts`                                                | Infrastructure failure is `errored` and costs no container; a task failure is graded                                                                      |
| F   | `apps/worker/tests/sandbox/evaluation.sbx.test.ts`                                                    | A corrupt patch, an unappliable patch and a wrong-case seed are all `ungraded`, and the job is untouched                                                  |
| G   | `apps/worker/tests/integration/evaluation.int.test.ts`                                                | Metrics agree with their sources, and do not move afterwards                                                                                              |
| H   | `pnpm demo:eval`, with its concurrency half in `evaluation.int.test.ts`                               | Two cases x two arms x two repetitions end to end with a real model, and a concurrent matrix that produces the rows a serial one does                     |

A through G need no model key and no network. Two properties of run C are worth calling out because
they are what make a negative assertion evidence rather than decoration:

- The container-wide search **proves it can find something** (a string the seed certainly contains)
  before it is trusted to find nothing. A search that silently failed would return nothing, and so
  does a clean container.
- The checkpoint search **decompresses first**, and a sentinel is deliberately planted in the
  workspace, captured through the production capture path, compressed the way the store compresses,
  and found again. A grep over the stored gzip column would pass whether the sentinel were there or
  not.

---

## Part 15. The verification ladder

```bash
# 1. offline, no infrastructure at all
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build

# 2. Postgres and Redis
pnpm test:integration        # includes runs E and G

# 3. Postgres only
pnpm test:streaming

# 4. Postgres, Redis and Docker
pnpm test:sandbox            # includes runs B, C, D and F

# 5. Docker, a model key, and money
pnpm eval:build
pnpm eval:run --dry-run      # always this first
pnpm demo:eval               # run H
```

Step 1 must keep working with no `DATABASE_URL`, no `REDIS_URL` and no Docker daemon. That is CI's
`verify` job, and it is what keeps the lazy clients and `force-dynamic` honest.

Run H was executed for this milestone as suite `9d0478f0-c04e-494a-97f9-a07257600a83`:
`bulk-discount-boundary` and `multi-line-order`, two arms, two repetitions,
`openrouter/deepseek/deepseek-v4-flash`, concurrency 1. It produced exactly 8 run rows over 8
distinct job ids with no nulls, one `case_version_hash` per case across all four of its runs, and 8
distinct `(case, arm, repetition)` cells. Every `none` run recorded `review.skipped` and a null
`reviewDecision`; every `independent` run recorded `review.recorded` and a decision. No event type
on any of the eight timelines mentions evaluation, benchmark, suite or grading. All 8 graded
`passed` with a score of 1.0000, at a total model cost of `$0.0245` and a median runtime of 136s -
and both of those aggregates reproduce by hand from the eight rows.

---

## Part 16. Experiment 1, and what it can support

The milestone's first result is in
[`docs/experiments/reviewer-value.md`](experiments/reviewer-value.md): five cases, two arms, three
repetitions, thirty runs, `openrouter/deepseek/deepseek-v4-flash`. The independent-review arm scored
15/15 against 14/15, at 43.9% more model cost and about 49% more wall time. The single failure was
`extract-pricing-module` under `none`, scoring 0.6667 - a job that completed, validated green, and
was wrong, which is exactly the case hidden tests exist to catch.

The write-up says in plain language what that sample can and cannot support, and this guide repeats
it: **fifteen runs per arm is enough to see a large effect and nowhere near enough to see a small
one.** A confident claim from this sample would undermine exactly the credibility the evaluation
framework exists to build.

Three further limits are deliberate:

- **Local fixtures are not real repositories.** They are small, dependency-free and authored by the
  same person who wrote the agent's prompts, which is a bias no amount of statistics removes. The
  honest next step is a handful of pinned real-world commits, and it belongs on the roadmap.
- **M10's corpus stopped at five.** M12 added three presentation and security cases, so the current
  corpus has eight. The PRD's "expand to 20" and "eventually 30-50" entries stay unchecked on
  purpose: the existing cases exercise every part of the harness, and the marginal architectural
  insight from cases nine through twenty is close to zero. Authoring more is content work, not
  milestone work.
- **Grading costs a container per run.** Dependency-free seed trees keep that to seconds each, and
  it is the price of grading a tree the model never saw the tests for.

---

## Part 17. When a number looks wrong

| Symptom                                             | Where to look                                                                                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Benchmark <id> changed since it was built`         | The case files were edited without `pnpm eval:build`. Rebuild, review the new `case.lock.json`, commit it                                                         |
| Every run is `errored` with `repo_unavailable`      | `RIVET_EVAL` is off on the worker, or `pnpm eval:build` was never run                                                                                             |
| Every run is `ungraded`                             | The grading seed or the checkpoint. Compare the run's job `base_commit_sha` against the case's lockfile                                                           |
| A run is `ungraded` with `grade_workspace_invalid`  | The re-derived checksum disagreed, the patch would not apply, or `setupCommand` failed. The reason is in the runner's log, deliberately not on the job's timeline |
| The success rate looks too high                     | Check the errored and ungraded counts next to it. They are excluded from the denominator by design                                                                |
| A score is between 0 and 1 on a `completed` job     | This is the intended signal: the job satisfied every check Rivet can run and failed the hidden rule                                                               |
| The failure histogram has a large unlabelled bucket | That is honest, not broken. Run `pnpm eval:label`                                                                                                                 |
| Two suites of "the same case" disagree              | Compare `case_version_hash` on the rows. That column exists for exactly this question                                                                             |

---

## Part 18. What the next milestone inherits

- A harness that measures the deployed system rather than a copy of it, so any later change to the
  lease, the queue, the sandbox or the agent shows up in the numbers.
- A re-runnable grader, so a corrected hidden test re-scores history for free.
- An arms array that already expresses Experiments 2 through 5 from §25 - planning on and off,
  context strategy, model comparison, retry strategy - without a new harness for each.
- One new input surface on the worker, `RIVET_EVAL`, listed here so M11's security review looks at
  it.
