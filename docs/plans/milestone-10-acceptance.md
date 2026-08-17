# Milestone 10: the acceptance contract

**Status: implemented.** This document was written before any M10 code, the way M8's and M9's were,
so the code was measured against it rather than the other way around.
[`docs/plans/milestone-10.md`](milestone-10.md) is the plan and
[`docs/milestone-10-guide.md`](../milestone-10-guide.md) is the tour of what was built. Runs A-G are
now code and pass with no model key and no network; run H is `pnpm demo:eval`. Where a run landed:

| run | where it lives                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | `packages/core/src/evaluation/case-loader.test.ts` (the builder), `apps/worker/src/eval-corpus.test.ts` (the corpus against its lockfiles) |
| B   | `apps/worker/tests/sandbox/local-seed.sbx.test.ts`                                                                                         |
| C   | `apps/worker/tests/sandbox/evaluation.sbx.test.ts`                                                                                         |
| D   | `apps/worker/tests/sandbox/evaluation.sbx.test.ts`                                                                                         |
| E   | `apps/worker/tests/integration/evaluation.int.test.ts`                                                                                     |
| F   | `apps/worker/tests/sandbox/evaluation.sbx.test.ts`                                                                                         |
| G   | `apps/worker/tests/integration/evaluation.int.test.ts`                                                                                     |
| H   | `pnpm demo:eval`                                                                                                                           |

Two places where the code took a slightly different route to the same assertion, both noted where
they occur. Run D's re-runnability is asserted in the integration suite against `eval:grade`'s
stored-patch path rather than with a second Docker case, because the claim is that re-scoring needs
no worker and no model - which is exactly what a suite with neither running proves. And run F's
wrong-case variant is refused by the seed's commit comparison **before** the checksum is reached,
which is the same refusal one step earlier and is asserted there.

M9 was the first milestone whose phase produced an effect Rivet cannot roll back, and its contract
spent its length on the runs where something went wrong at the worst moment. M10's risk is different
and quieter. **An evaluation harness fails by producing a number that is wrong in a way nobody
notices.** A hidden test that leaked into the training context, a grader that scored a tree the job
did not produce, an infrastructure outage averaged into a task success rate, two runs of "the same
case" that were not the same case - each of those produces a clean-looking table and a defensible
paragraph, and each of them is worse than a harness that visibly crashes. So this contract spends
most of its length on **negative assertions**: what must be absent, what must not have been graded,
what must not have been counted.

Eight runs are specified:

| run                                    | ends                                    | why it is here                                   |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| A. build the fixtures twice            | identical SHA and version hash          | a benchmark you cannot rebuild is not a pin      |
| B. a job seeded from `rivet-local:`    | `completed`, tree matches byte for byte | the seed source must not invent a working tree   |
| C. hidden tests are nowhere            | a sentinel grep finds nothing           | the entire value of a hidden test                |
| D. good diff vs public-tests-only diff | `passed` / `failed` with a score        | the grader must actually discriminate            |
| E. a job that never checkpoints        | `errored`, no grading container         | infrastructure failure is not task failure       |
| F. a tampered checkpoint               | `ungraded`, excluded from the rate      | grading the wrong tree is worse than not grading |
| G. metrics agree with their sources    | field-by-field equality                 | denormalized numbers drift silently              |
| H. a two-arm suite over two cases      | 8 runs, 8 jobs, hand-checked table      | the aggregate is the deliverable                 |

Runs A, E and G are the worker integration suite (`apps/worker/tests/integration/`): Postgres,
Redis, real BullMQ workers, `RIVET_SANDBOX=off` where a container adds nothing. Runs B, C, D and F
are the sandbox suite (`apps/worker/tests/sandbox/`): real Docker, because every one of them asserts
something about bytes inside a container, and asserting that against `FakeSandboxProvider` would be
asserting the fake. Both are already CI jobs, so "A-G pass in CI with no model key" holds. Run H is
`pnpm demo:eval`, local, with a real model key, and is not part of CI.

Everything below is derived from what the system emits today -
`packages/contracts/src/job-event.ts`, `packages/contracts/src/validation-check.ts`, the phase
bodies under `packages/core/src/pipeline/`, `packages/core/src/checkpoints/`, the `jobs` columns in
`packages/database/src/schema/job.ts` - plus exactly the tables and schemas the plan names. **No job
event type and no failure category is invented here**, because M10 adds none; see the plan's
vocabulary section and run C's third assertion.

---

## How to read a sequence

The two-part convention M8 established and M9 carried over, with one addition.

**Statuses** are read from the `jobs` row, and their order from the timeline: the `to` field of
`job.claimed` followed by the `to` of every transition. **M10 adds no status and no transition
edge.** A job created by the evaluation runner walks exactly the sequence a job created in the web
form walks.

**Events** are the `type` column in `id` order, asserted as a projection: the ordered subsequence
drawn from a fixed set, everything else ignored. M10's projection set is M9's set, unchanged and
unextended, which is itself an assertion - see run C.

**Grading** is new, and it is deliberately not on the timeline. A grade is a row in
`evaluation_runs` and a container the runner owned; the job it graded knows nothing about it. So
grading assertions in this document are written against the run row and the grading container, never
against `job_events`.

Every run below abbreviates the `provisioning` through `finalizing` event prefix as `<prefix>`,
because M10 changes nothing about it. The prefix is exactly run A of the M9 contract, and any test
here that re-asserts it is asserting M9.

## The wiring the acceptance tests use

- **Runs A, E, G**: Postgres, Redis, BullMQ, the real processor, `FakeSandboxProvider` and
  `FakeCodingAgent` as in M8, `RIVET_GITHUB=off`, `RIVET_EVAL=on`.
- **Runs B, C, D, F**: real Docker via the dockerode adapter, the pinned base image, real host Git
  for the local seed, `RIVET_AGENT=scripted`, `RIVET_GITHUB=off`, `RIVET_EVAL=on`.
- **A scripted agent that writes a named diff**, which needs no new machinery.
  `RIVET_AGENT=scripted` already loads an arbitrary module from `RIVET_AGENT_SCRIPT` that supplies a
  `CodingAgent`, and `recovery-demo-agent.ts` is already exactly that: a scripted planner and
  implementer that makes one named edit against a known fixture. Run D's two arms are two such
  modules over the same seed - or one module selecting on an env var, which is cheaper and keeps the
  two diffs coming from the same mechanism. That last property is the requirement: if the good diff
  and the public-tests-only diff are produced differently, run D compares mechanisms rather than
  grades.
- **No model key, in A through G.** Any run in this document that would fail without
  `OPENROUTER_API_KEY` is in the wrong suite.
- **No network, in A through G.** The bare repositories are on disk; there is no GitHub in this
  milestone's tests, deliberately, because M9's suites already cover the authenticated path.

## The two cases the tests use

Runs A-G do not need all five authored cases and must not depend on them, because Stage 4 is content
that will keep being edited and a test that breaks when a hidden test is improved is a test that
teaches people to stop improving hidden tests. A-G run against **two fixture cases owned by the test
suite**, under `apps/worker/tests/fixtures/benchmarks/` - a new directory, and deliberately not
`tests/sandbox/fixtures/` where the existing repo fixture lives, because these two cases are read by
both the integration and the sandbox suite and a fixture owned by one suite that another imports is
how a test directory starts depending on its neighbours:

- `fixture-pass` - one seeded bug, a public test that names it, a hidden test that checks the
  boundary the public test does not.
- `fixture-partial` - a public suite that goes green on the obvious implementation, and a hidden
  test encoding a rule stated only in the issue text. This is `multi-line-order`'s shape, and it is
  what makes run D's second arm expressible.

Both carry a distinctive sentinel string in `hidden/` - `RIVET_HIDDEN_SENTINEL_<random>` - which is
what turns run C into a grep rather than an argument, the same device run H of the M9 contract uses
for the GitHub token.

The five real cases in `benchmarks/` are exercised by run H and by Stage 9, and by exactly one
assertion in CI: that every one of them loads, validates, and builds to the SHA in its
`case.lock.json`. That assertion belongs with run A.

---

## The run result vocabulary is normative

`evaluation_runs.result` is one of four values, decided **in this order**, and the order is the
contract:

```text
1. errored   - the job never reached a state that can be judged
2. ungraded  - grading itself could not run
3. passed    - job completed AND hidden tests passed AND validation outcome is not `regressed`
4. failed    - everything else
```

`errored` is decided from the job row alone, with no container:

```text
status = cancelled
status = failed AND failure_category IN (
  timed_out, budget_exceeded, lease_expired, worker_crash,
  sandbox_unavailable, sandbox_create_failed, repo_unavailable,
  dependency_install_failed, oom_killed, sandbox_leaked,
  agent_unavailable, agent_failed,
  checkpoint_corrupt, checkpoint_restore_failed, checkpoint_too_large,
  github_unavailable, github_permission_denied, push_rejected,
  pull_request_failed, github_not_installed,
  validation_config_invalid, unsupported_project, unknown
)
```

Everything else that failed is a **task** failure and is `failed`, not `errored`:
`no_changes_produced`, `validation_failed`, `plan_not_produced`, `review_not_produced`,
`reviewer_rejection`, `command_timed_out`. Those are statements about the work; the list above is
statements about Rivet and its environment. A unit test asserts that the two lists together cover
`FAILURE_CATEGORIES` exhaustively, with a `satisfies` on the union so **adding a failure category in
a later milestone fails typecheck until it is classified**. That assertion is the single most
valuable line in the milestone: an unclassified category silently defaulting either way is exactly
how an infrastructure failure rate leaks into a task success rate.

`command_timed_out` sitting on the task side is a judgement call and is recorded as one. A command
that blew its own budget is usually the model writing a script that hangs, which is about the work.
The job blowing `max_duration_seconds` is `timed_out` and is on the other side.

**Success rate is computed over `passed + failed` only.** `errored` and `ungraded` runs are counted,
reported and shown, and are excluded from the denominator. Run H asserts both numbers.

## `metrics_json` is normative

Denormalized at grade time, from the job row and the `validation_report` and `diff_stat` artifacts.
Field names and sources:

```text
runtimeSeconds        completed_at - started_at, null if either is null
totalModelCalls       jobs.total_model_calls
totalToolCalls        jobs.total_tool_calls
totalTurns            jobs.total_turns
totalInputTokens      jobs.total_input_tokens
totalOutputTokens     jobs.total_output_tokens
totalCostUsd          jobs.total_cost_usd            (string, not float; see below)
attemptCount          jobs.attempt_count
reviewLoops           jobs.review_loops
reviewDecision        jobs.review_decision            (null when review was skipped)
reviewBlockingCount   jobs.review_blocking_count
validationOutcome     validation_report.outcome
newFailureCount       sum of newFailures.length over binding checks
fixedFailureCount     sum of fixedFailures.length over binding checks
filesChanged          diff_stat
insertions            diff_stat
deletions             diff_stat
hiddenTestsTotal      the grading run's parsed test totals
hiddenTestsPassed     the grading run's parsed test totals
```

`totalCostUsd` stays a **string** all the way through, because the column is `numeric(10,4)` and the
one thing an evaluation harness must not do is report a cost that a float rounded. Zod validates it
as a decimal string. Run G asserts it round-trips.

`score` is `hiddenTestsPassed / hiddenTestsTotal`, `numeric(5,4)`, null when grading did not run. It
is deliberately not the `result`: a run that passes 7 of 8 hidden assertions is a `failed` run with
a score of 0.8750, and flattening that to zero would hide the difference between a near miss and a
model that did nothing.

---

## A. The fixture builder is deterministic

The cheapest run and the one everything else rests on. Unit test plus an integration assertion, no
Docker, no Postgres for the first half.

**Build twice, from a clean `.rivet/benchmarks/`:**

```text
the bare repo's HEAD sha       identical across both builds
the version hash                identical across both builds
the commit's tree sha           identical across both builds
the commit's author/committer   the constants in case.json, not the machine's git config
the commit's author/commit date the constant in case.json, in both slots
the commit's parent             none; a single root commit
the commit's message            a fixed string, not a timestamp
```

**Build in a different directory, under a different `TZ`, with a different `git config user.name`
and `user.email` in scope:** the same SHA. Environment leaking into a benchmark's identity is the
failure this asserts, and `TZ` is the one that will actually happen.

**Mutate the seed tree by one byte and rebuild:** a different version hash **and** a different
commit SHA. Mutate a file under `hidden/` only: a different version hash and the **same** commit
SHA - the hidden tests are part of the case's identity and are not part of the seeded repository,
and those two facts must both be visible in one test.

**Against the checked-in lockfile:** for each of the five real cases in `benchmarks/`, the built SHA
equals `case.lock.json`'s, and a mismatch fails loudly and names both SHAs. This is the assertion
that catches a case edited without a rebuild, and it is why the lockfile is git-tracked.

**Case validation:** a `case.json` with an unknown key, an empty `validationCommand`, a
`validationCommand` given as a shell string, a `difficulty` of 0 or 7, a category outside the §24.1
set, or a `hidden/` directory that is empty - each is a named load failure, not a case that builds
with a default. A `repo/` containing a path that also exists in `hidden/` is a load failure too:
grading overwrites, and a case where the overwrite is silent is a case whose author did not mean it.

**The two closed vocabularies Stage 1 needs are fixed here**, because both exist in the PRD as prose
and Stage 1 would otherwise have to invent the identifiers. `category` is §24.1's seven, in
snake_case:

```text
bug_fix, feature, refactor, test_generation, concurrency, api_change, database_change
```

`difficulty` is an integer **1 through 6**, which is §32's full ladder - simple deterministic bug,
repository search, multi-file feature, test creation, database change, concurrency. The plan's
"level 1-4" describes the five cases M10 actually authors, not the bound the schema enforces; a
schema that refuses a level 5 case would have to be migrated by the first person who writes one, and
the ladder is already six rungs long in §32. Levels 5 and 6 are unused in M10 and that is a fact
about the corpus, not about the contract.

## B. A job seeded from `rivet-local:`

Real Docker. A job created with `repoUrl: "rivet-local:fixture-pass"`, `RIVET_EVAL=on`, no GitHub
binding.

**Statuses** - identical to an ordinary job's:

```text
queued -> provisioning -> analyzing -> planning -> implementing -> testing -> reviewing
       -> finalizing -> completed
```

**Projected events** - identical to run A of the M9 contract, ending
`publication.skipped { reason: "github_off" }`. Stated as an assertion rather than as prose: the
projected event list of this job and the projected event list of an equivalent job against a plain
https URL are **equal**. If they are not, the harness is measuring a different system than
production runs, which is the plan's own stated requirement and is worth failing a test over.

**Assertions inside the container:**

```text
git status                     clean
git rev-parse HEAD             equals the case's pinned base commit
git log --oneline | wc -l      exactly 1
ls -R                          matches `repo/` exactly: same paths, same modes, same bytes
find . -name '._*'             nothing
a binary file in the seed      byte-identical, sha256 compared
.git/config                    no remote, no credential helper
SandboxSpec.env                no credential of any kind
```

The `._*` assertion and the byte-for-byte comparison are the `--no-xattrs` /`COPYFILE_DISABLE=1`
regression test for the second archive path, and they are non-negotiable: AGENTS.md already records
what a forgotten flag costs, and `localSeed()` sharing helpers with `seedClone()` is a claim this
run verifies rather than a claim the code makes.

**Scheme assertions**, unit-tested as a pure resolver, no container:

```text
rivet-local:fixture-pass         resolves under RIVET_BENCHMARK_ROOT
rivet-local:../../etc            refused
rivet-local:/etc/passwd          refused
rivet-local:a/../../b            refused
rivet-local:fixture-pass with a symlinked case dir escaping the root   refused
file:///tmp/x                    refused, always, RIVET_EVAL or not
rivet-local:fixture-pass under RIVET_EVAL=off                          refused
createJobSchema.repoUrl with rivet-local: from the web form            refused
```

The last two are the security assertions. `RIVET_EVAL=off` must refuse the scheme at the worker, and
the browser-facing schema must refuse it regardless, so the surface is opened in exactly one place.
`parseWorkerConfig` refusing `RIVET_EVAL=on` under `NODE_ENV=production` gets the same unit test its
three siblings have.

## C. The hidden tests are nowhere

The run this milestone's credibility rests on. Run B's job, with `fixture-partial`, whose `hidden/`
contains the sentinel string.

**Grep the sentinel across every surface the job touched:**

```text
the container filesystem, whole            not found  (find / -type f | xargs grep, or a tar scan)
every job_commands row: argv, stdout, stderr  not found
every job_events row: the whole jsonb      not found
every job_artifacts row: content           not found  (diff, diff_stat, summary, plan, both reports)
every job_checkpoints row: the patch bytes not found  (decompressed, then searched)
the agent session's transcript             not found
the worker's captured log output           not found
```

Six of those seven are cheap. The checkpoint one is the one that matters most and is the easiest to
get wrong: the patch is gzip in Postgres, so a naive grep over the column finds nothing whether the
sentinel is there or not. **The test must decompress first**, and a second assertion proves the test
itself works: inject the sentinel into the workspace deliberately, capture, decompress, and assert
the grep _does_ find it. A negative assertion with no positive control is not evidence.

**Two structural assertions alongside the grep:**

```text
the bare repository built for the case   contains no path under hidden/
the projected event list                 contains no event type outside JOB_EVENT_TYPES as of M9
```

The second is how "M10 adds no job event type" stops being a sentence in a plan. A snapshot of
`JOB_EVENT_TYPES.length` is not the assertion - a snapshot invites an update - the assertion is that
an evaluation job's timeline and an ordinary job's timeline draw from the same vocabulary.

## D. The grader discriminates

Real Docker, `fixture-partial`, two scripted diffs against the same seed and the same case.

**Arm 1 - the known-good diff.** Public tests green, hidden tests green.

```text
result             passed
score              1.0000
failure_category   null
the grading container was created, ran, and was destroyed
hiddenTestsPassed  equals hiddenTestsTotal, and hiddenTestsTotal > 0
```

**Arm 2 - the public-tests-only diff.** Satisfies the public suite, violates the rule stated in the
issue but tested only in `hidden/`.

```text
result             failed
score              strictly between 0 and 1
failure_category   null  (this is a judgement call, see run G's labelling section)
the job itself     completed - validation was green, and that is the point
```

Arm 2 is the run that justifies the whole hidden-test design. The job passed every check Rivet can
run, the reviewer may well have approved it, and it is wrong. If arm 2 ever grades `passed`, the
hidden test is not encoding the rule the issue stated, and the correct response is to fix the case,
not the assertion.

**Three grader mechanics, asserted on both arms:**

```text
the grading container's base image     the same pinned digest the job ran on
the grading container's tree           the job's tree, re-derived and SHA-256 matched, before
                                       hidden/ is copied in
hidden/ overwrites                     a scripted diff that creates a file at a hidden/ path does
                                       not survive; the case's version wins
the container is destroyed             on the passing path, the failing path, and the throwing path
                                       - asserted with a forced throw between copy and run
setupCommand                           runs before validationCommand when present, and its non-zero
                                       exit is `ungraded`, not `failed`
```

The `setupCommand` rule follows run F's logic: a fixture that would not build is a broken grading
environment, and scoring a solution zero because the harness could not set up is the same category
of lie as scoring a tampered tree.

**Re-runnability**, which is `pnpm eval:grade`'s reason to exist: re-grade the same suite with no
worker running and no model key, and get identical `result`, `score` and hidden-test totals, written
to the same rows. Then edit the case's hidden test so arm 2 passes, re-grade, and assert the row now
reads `passed` with the **new** `case_version_hash` recorded and the old one still visible on the
first grading. A re-score that quietly overwrites which case it scored is the "two runs of the same
task that were not the same task" failure, arriving through the back door.

## E. A job that never checkpoints grades `errored`

Integration suite, no Docker. A job that fails in `provisioning` - `sandbox_create_failed` is the
cleanest - so there is no checkpoint row at all.

```text
result                      errored, and explicitly NOT ungraded
score                       null
graded_at                   set  (it was judged; it just needed no container)
metrics_json                present, with runtimeSeconds and the usage totals, and nulls where the
                            job produced nothing
the Sandbox port            received ZERO create calls from the grader
job_id                      set - the job exists and its timeline is the record
```

**`errored` rather than `ungraded` is the whole assertion**, and the wrong answer is the tempting
one: there is no checkpoint, so grading could not run, so `ungraded` looks right. It is not. The
ordering at the top of this document is what settles it - the job is classified before grading is
attempted, so a job that failed in `provisioning` never reaches the question. `ungraded` is reserved
for a job that _could_ have been graded and whose grading broke, which is run F. Conflating them
puts Docker outages in the same bucket as harness bugs.

The zero-create assertion is the run's other point and must be made against the port, not inferred
from timing. A grader that provisions a container to discover there is nothing to grade costs a
container per infrastructure failure, and infrastructure failures come in bursts.

**A variant with the opposite shape:** a job that failed with `no_changes_produced` after
checkpointing. That is a **task** failure, so it grades `failed` rather than `errored`, and it
_does_ provision a grading container, because a tree that changed nothing still has hidden tests to
fail. The two variants together are the assertion that the classification list above is being read,
rather than "did the job complete" being read.

**And the aggregate assertion:** a suite containing one `errored` run and one `passed` run reports a
success rate of 100%, an errored count of 1, and a total of 2. All three numbers, in one assertion,
because reporting the first without the second two is precisely the averaging the plan forbids.

## F. A tampered checkpoint grades `ungraded`

Real Docker. Run D arm 1, then flip one byte in the stored patch before grading.

```text
result                 ungraded
score                  null
failure_category       "grade_workspace_invalid"     (the runner's vocabulary, not the job's)
failure_label_source   "auto"
the job row            untouched: still `completed`, its own status unchanged
the job's timeline     unchanged - no event was written about the grading failure
the grading container  destroyed
excluded from the success rate denominator, and reported as an ungraded count
```

Two variants, because there are two ways the tree can be wrong and they must both land here rather
than in `failed`:

- **The patch does not apply** to the case's base commit at all.
- **The patch applies, and the re-derived SHA-256 disagrees** with the stored one. This is the more
  interesting variant and the one that catches a grader seeded from the wrong case: point the
  grading container at `fixture-pass` while grading a `fixture-partial` run, and the checksum must
  be what notices.

The job-untouched assertion is worth stating separately. A grading failure is the runner's problem;
writing anything onto the job would make the evaluation harness a second writer of job state, and
this system has exactly one writer per table for a reason.

## G. Metrics agree with their sources

Integration suite. One completed job with a non-trivial history - a review loop, more than one
attempt, a real validation report with a fixed failure and a pre-existing one - graded, then
compared field by field.

```text
for every field in the metrics_json table above:
  the stored value equals the value read directly from its named source, right now
runtimeSeconds        equals completed_at - started_at to the second
totalCostUsd          equals the numeric column as a string, character for character
newFailureCount       equals the count recomputed from the validation_report artifact
filesChanged          equals the count recomputed from the diff_stat artifact
reviewDecision        null when review.skipped was written, a decision when review.recorded was
```

The `reviewDecision` line is the M8 distinction carried into the metrics: "no reviewer looked at
this" and "a reviewer had nothing to say" stay different facts, and an arm labelled `none` in
Experiment 1 whose runs report a review decision would invalidate the experiment.

**Immutability**, which is why the column is denormalized at all: after grading, change the job's
`total_cost_usd` directly, re-read the run row, and assert `metrics_json` is **unchanged**. History
that a later write can rewrite is not history.

**Automatic labels**, asserted as a table on the pure classifier, not through the pipeline:

```text
budget_exceeded, terminal                        -> "Budget exceeded",       auto
sandbox_* / repo_unavailable / oom_killed        -> "Environment failure",   auto
agent_failed with a tool assertion failure       -> "Tool failure",          auto
review_decision = approve AND result = failed    -> "Reviewer false positive", auto
turn ceiling reached with no diff growth         -> "Agent loop",            auto
everything else that failed                      -> null,                   null source
```

The `null` row is the assertion people will want to delete. `Incorrect diagnosis`,
`Insufficient context`, `Bad implementation` and `Test misunderstanding` are not machine-decidable,
and a classifier that guesses them produces a failure histogram that looks rigorous and is fiction.
The column records `auto` or `manual` for exactly this reason, and the dashboard must show the
unlabelled count rather than hiding it - run H asserts that number is rendered.

`pnpm eval:label` writing a manual label sets `failure_label_source = "manual"` and never overwrites
an `auto` label without being told to.

## H. A two-arm suite over two cases

The milestone's demonstration. `pnpm demo:eval`, local, real Docker, real model key, real workers -
the same shape as `demo:job` and `demo:pr`, and it asserts `RIVET_EVAL=on`, `RIVET_SANDBOX=docker`,
`RIVET_AGENT=pi` and `OPENROUTER_API_KEY` up front, naming what is missing rather than failing
halfway through a paid matrix.

Two cases x two arms (`independent`, `none`) x two repetitions.

```text
evaluation_runs rows            exactly 8
distinct job_id values          exactly 8, none null
distinct (case, arm, rep)       exactly 8 - the unique constraint holds
jobs created                    8, every one of them claimed by a real worker under a real lease
case_version_hash on each run   equals the built case's hash, identical across all 4 runs of a case
arm = "none" runs               review.skipped on the timeline, reviewDecision null in metrics
arm = "independent" runs        review.recorded on the timeline, reviewDecision set
every run's timeline            indistinguishable from an ordinary job's: same projection set, no
                                event mentioning evaluation, benchmark, suite or grading
```

**`--dry-run` first, and it is asserted.** `pnpm eval:run --dry-run` prints the 8-row matrix,
creates no job, enqueues no message, writes no row, and starts no container. That is the command
anyone runs before spending money and it must be provably free.

**The aggregate table is checked by hand.** The suite page at `/evaluations/:id` is compared against
a table computed manually from the 8 rows:

```text
success rate overall, and per arm, and per case, and per category
k/N per (case, arm), with the spread visible - never a single boolean
errored count and ungraded count, shown, and excluded from the success denominator
the §24.4 efficiency aggregates: median runtime, total and mean cost, model calls, tokens
the §24.5 failure histogram, including the unlabelled bucket
every run row linking to /jobs/<id>
```

The link assertion is small and is the architectural claim of decision 1: the evaluation surface
stores aggregates and grades and stores no second copy of anything the job log already holds. Click
any number and you land on a full timeline, plan, diff, validation report and review report that
existed before this milestone.

**`RIVET_EVAL_CONCURRENCY`** is asserted at 1 and at 2: at 2, two jobs are in flight simultaneously
(observed through overlapping `started_at`/`completed_at` windows), and the row count, the grades
and the aggregates are identical to the serial run. Concurrency that changes results is concurrency
that is grading a shared container.

---

## What this contract deliberately does not pin down

- **The five real cases' contents.** Stage 4 is content and will keep being edited. A-G run against
  the two suite-owned fixtures precisely so that improving a hidden test never breaks a test of the
  harness. The real cases get one CI assertion - they load, validate and build to their lockfile.
- **Model behaviour on any case.** No assertion anywhere says a real model passes a real case. That
  is the number the harness exists to _measure_, and a test asserting it would be a test that fails
  when the answer is interesting.
- **Experiment 1's outcome.** Stage 9 runs it and writes it up. This contract asserts the machinery
  produces two arms and a comparable table, and asserts nothing about which arm wins. A contract
  that expected a result would be a contract that pre-registered its own conclusion.
- **Absolute timings.** Grading takes "seconds" because the seed trees are dependency-free; a test
  that asserts a duration is asserting a laptop.
- **Dashboard wording and layout.** Assert the numbers, the buckets and the links. Charts are M12.
- **How many repetitions are statistically enough.** Three is a configured default, not a claim. The
  write-up says so in plain language, and this contract's only requirement is that the spread is
  displayed rather than averaged away.

## Obligations this contract places on the code

Writing the assertions down first surfaces six things the plan implies but does not state, and each
is cheaper to decide now than to discover in Stage 7.

1. **The `errored` classification must be exhaustive over `FAILURE_CATEGORIES` at compile time.** A
   `Record<FailureCategory, "infrastructure" | "task">` rather than an array of the interesting
   ones, so a category added in M11 fails typecheck until someone decides which side of the success
   rate it belongs on. This is the single assertion most likely to be worth its weight in two
   milestones.
2. **The grader takes the `Sandbox` port, not dockerode**, and it must take the _provider_, not a
   live container, because run E's assertion is that it never asks for one. That shape also lets run
   E stay in the integration suite with no Docker at all.
3. **`localSeed` must share `seedClone`'s archive helpers, not copy them.** Run B's `._*` and
   byte-identity assertions are written to fail on a second archive path that forgot a flag, but the
   cheaper guarantee is that there is only one archive path. Stage 5 should extract before it adds.
4. **The runner needs a terminal-status wait that cannot hang forever.** `job-demo.ts`'s polling
   shape plus a bound: a suite of 30 runs where one job is stuck must fail that run and continue,
   rather than blocking the matrix. The stuck run grades `errored`.
5. **Grading must never write to `jobs` or `job_events`.** Run F asserts it for the failing path;
   the invariant is broader and belongs in AGENTS.md next to the single-writer list.
   `evaluation_runs` is the evaluation harness's only writable surface on a completed job, and it
   does not even live in the same table.
6. **`benchmark_cases` needs the cache docblock the plan promises.** It is the second table in the
   system that is a cache rather than a record, and the first thing a reader will assume is that it
   is authoritative. Editing a row must change nothing; run A's lockfile assertion is what makes
   that true, and the docblock is what makes it obvious.

## The Stage 0 fixture repositories

Unlike M9, this milestone needs **no external repository at all**, and that is the point of
decision 3. `apps/worker/tests/fixtures/benchmarks/` holds the two suite-owned cases; `benchmarks/`
at the repo root holds the five real ones; `.rivet/benchmarks/` holds the built bare repositories
and is gitignored. Nothing here can be rate-limited, edited by a stranger, or unavailable offline.

`rivet-fixture-node` keeps its existing job: it is `demo:job`'s and `demo:recovery`'s target and
stays the deliberately boring constant those milestones depend on. It does **not** become a
benchmark case. `bulk-discount-boundary` and `multi-line-order` are _ported_ into `benchmarks/` as
seed trees, and once they exist, `demo-tasks.ts` becomes a thin re-export of the two cases' issue
text rather than a second place a task is written down - which is the small cleanup that keeps this
milestone from adding a third.
