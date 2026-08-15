# Milestone 8: the acceptance contract

This is Stage 0's written-down answer to "what does a passing M8 look like", and it is written
before any phase code so that the phase code is measured against it rather than the other way
around. [`docs/plans/milestone-8.md`](milestone-8.md) is the plan; this document is the set of
assertions the Stage 10 integration tests make.

Six runs are specified, and the first four are the ones the plan names:

| run                               | ends                            | why it is here                                     |
| --------------------------------- | ------------------------------- | -------------------------------------------------- |
| A. approved on the first loop     | `completed`                     | the default path, and the one that must stay cheap |
| B. one revision, then approved    | `completed`                     | the loop actually going around                     |
| C. revised until the bound        | `failed`, `reviewer_rejection`  | the bound is Rivet's, not the reviewer's           |
| D. `reviewMode: "none"`           | `completed`                     | review is a property of the job                    |
| E. session ends without a verdict | `failed`, `review_not_produced` | a missing verdict is never an approval             |
| F. crash during `revising`        | `completed`                     | a crash must not refund the loop budget            |

Everything below is derived from what the pipeline emits today -
`packages/contracts/src/job-event.ts`, the phase bodies under `packages/core/src/pipeline/`,
`apps/worker/src/processor.ts` and the existing suite under `apps/worker/tests/integration/` - plus
exactly the four new events the plan names: `review.recorded`, `review.revision_requested`,
`review.limit_reached` and `review.skipped`. No other event is invented here. Where this document
requires behaviour that the current code cannot express, it says so under
[Obligations this contract places on later stages](#obligations-this-contract-places-on-later-stages)
rather than quietly assuming it.

## How to read a sequence

Two different things get asserted and they are worth keeping apart.

**Statuses** are read from the `jobs` row, and their order is read off the timeline the way
`pipeline.int.test.ts` already does it: the `to` field of `job.claimed` followed by the `to` field
of every `job.status_changed`-shaped transition. Every status listed is a real value in
`JOB_STATUSES` and every adjacent pair is a legal edge in `ALLOWED_TRANSITIONS`.

**Events** are the `type` column, in `id` order. A run of this pipeline emits hundreds of rows -
`command.started`, `agent.message`, `agent.usage` - and asserting all of them would produce a test
that fails whenever a fake sandbox script changes. So each sequence below is stated as a
**projection**: the ordered subsequence of event types drawn from a fixed set, with everything else
ignored. The projection set for every sequence in this document is:

```text
job.claimed, phase.started, phase.completed,
baseline.recorded, validation.recorded,
plan.recorded, review.recorded, review.revision_requested,
review.limit_reached, review.skipped,
checkpoint.created, checkpoint.restored, run.resumed,
run.summarized, job.completed, job.failed, job.reclaimed
```

An assertion is therefore `events.filter(inProjection).map(type)` equals the listed array, plus
`toMatchObject` on the `data` of the rows this document gives fields for. Anything outside the
projection is deliberately unpinned: a test that asserts the exact number of `agent.message` rows is
asserting a property of a fake, not of Milestone 8.

`phase.started` and `phase.completed` carry `data.phase`, which is the phase **label**, not the
status. The labels this contract uses are the ones in `PHASE_TEMPLATE` plus one new one:

```text
provisioning  Provision sandbox
analyzing     Establish test baseline
planning      Create plan
implementing  Implement change
testing       Validate change
reviewing     Review patch
revising      Revise change      <- new in M8, and normative here
finalizing    Finalize
```

## The wiring the acceptance tests use

The same wiring `agent.int.test.ts` already uses, and for the same reason: Postgres, Redis, BullMQ,
the production processor and the production phase context stay real, and only the two external
adapters are scripted. `FakeSandboxProvider` gives `provisioning` a repository to work with,
`FakeCodingAgent` supplies deterministic session events, and `buildPipeline` is handed both. No
model key, no Docker.

The reviewer is scripted the same way the planner and the implementer are, which is what makes runs
B, C and E expressible at all: the fake must be able to play a `reviewer`-role session that submits
a verdict, submits a different verdict on the next loop, or ends without submitting anything. That
is Stage 4's `Reviewer support in the scripted fake`, and it is the one Stage 0 deliverable that
could not be written before Stage 1's report schema and Stage 3's role exist.

Two scripted-session facts every sequence below assumes:

- The implementer's edits produce a non-empty staged diff, because `testing` fails a job whose diff
  is empty with `no_changes_produced` before it validates anything.
- The scripted checks compare green, so `testing` does not throw `ValidationFailedError` and the run
  reaches `reviewing` at all. Review's job is the case where validation has nothing left to say.

## The phases, and what each one contributes to a projection

Stated once here so the six sequences can be short. Within one phase the order is the order the
phase body writes in.

```text
provisioning   phase.started -> (sandbox.created, repo.cloned, deps.installed) -> phase.completed
               no boundary checkpoint: provisioning is absent from BOUNDARY_CHECKPOINT_PHASES

analyzing      phase.started
               -> baseline.check_recorded x {test, typecheck, lint}
               -> baseline.recorded
               -> artifact.recorded (baseline_report)
               -> checkpoint.created (completedPhase analyzing, resumePhase planning)
               -> phase.completed

planning       phase.started -> agent session -> artifact.recorded (implementation_plan)
               -> plan.recorded
               -> checkpoint.created (completedPhase planning, resumePhase implementing)
               -> phase.completed

implementing   phase.started -> agent session, checkpoint.created per completed turn
               -> checkpoint.created (completedPhase implementing, resumePhase testing)
               -> phase.completed

testing        phase.started
               -> artifact.recorded (diff), artifact.recorded (diff_stat)
               -> validation.check_recorded x {targeted_test, test, typecheck, lint}
               -> artifact.recorded (validation_report)
               -> validation.recorded
               -> checkpoint.created (completedPhase testing, resumePhase reviewing)
               -> phase.completed

reviewing      phase.started -> reviewer session
               -> artifact.recorded (review_report)
               -> review.recorded
               -> [review.revision_requested | review.limit_reached]
               -> checkpoint.created (completedPhase reviewing)
               -> phase.completed

revising       phase.started -> agent session, checkpoint.created per completed turn
               -> checkpoint.created (completedPhase revising, resumePhase testing)
               -> phase.completed

finalizing     phase.started -> artifact.recorded (implementation_summary)
               -> run.summarized
               -> phase.completed
               no boundary checkpoint: the finalizing -> completed transition is the acknowledgement
```

The boundary `checkpoint.created` is written **before** `phase.completed` on purpose, and the
acceptance tests assert that order: a phase is not safely complete until the workspace it produced
is durable, so a crash between the two replays the phase instead of skipping it.

## The four new events and the fields they carry

Field names are normative; Stage 1 adds them to `JobEventData`. `reviewLoop` counts revisions
**already spent** when the verdict was produced, so the first reviewer session on any job records
`reviewLoop: 0`, and it is exactly `jobs.review_loops` as read at the top of the phase.

### `review.recorded`

Written by `reviewing` immediately after the `review_report` artifact, on every verdict including
the one that ends the job.

```ts
{
  artifactId: number,            // the review_report row, always resolvable
  artifactType: "review_report",
  agentRole: "reviewer",
  reviewDecision: "approve" | "revise",
  reviewLoop: number,            // revisions already spent, 0 on the first review
  blockingCount: number,
  nonBlockingCount: number,
  confidence: number,            // 0..1
}
```

`blockingCount` is 0 exactly when `reviewDecision` is `approve`, and at least 1 exactly when it is
`revise`. The schema enforces that cross-field rule at the tool boundary, so a test that asserts it
here is asserting that the phase persisted what the tool validated.

### `review.revision_requested`

Written only when the verdict is `revise` **and** there is loop budget left, after `recordReview()`
has incremented the counter, and before the directive returns.

```ts
{
  reviewLoop: number,            // the loop that just produced the verdict, 0-based
  reviewLoops: number,           // jobs.review_loops after the increment: reviewLoop + 1
  maxReviewLoops: number,        // jobs.max_review_loops
  blockingCount: number,
}
```

### `review.limit_reached`

Written when the verdict is `revise` and the counter has reached the bound, immediately before
`ReviewerRejectionError` is thrown. It is the last review event on a rejected job, and it exists so
the timeline says the bound was the reason rather than leaving a reader to infer it from a failure
category.

```ts
{
  reviewLoops: number,           // equals maxReviewLoops
  maxReviewLoops: number,
  blockingCount: number,
  failureCategory: "reviewer_rejection",
}
```

### `review.skipped`

Written by `reviewing` when the job's `review_mode` is `none`, as the phase's only act.

```ts
{
  reviewMode: "none",
}
```

`review.skipped` is a statement about the **job's** mode, not about the worker's configuration. A
pipeline built without an agent at all (`RIVET_AGENT=off`) leaves `reviewing` as the M1 sleep and
writes no review event of any kind, which is what keeps the thirty-odd existing lifecycle tests in
`pipeline.int.test.ts` valid without a single edit. The two absences are different facts and the
timeline distinguishes them: no review event means nothing reviewed because this worker cannot,
`review.skipped` means nothing reviewed because this job said not to.

## A. Approved on the first loop

The default path. Created with `reviewMode: "independent"` (the column default) and
`maxReviewLoops: 2`; the scripted reviewer approves.

**Statuses**

```text
queued -> provisioning -> analyzing -> planning -> implementing -> testing -> reviewing
       -> finalizing -> completed
```

**Projected events**

```text
job.claimed                { to: "provisioning" }
phase.started              { phase: "Provision sandbox" }
phase.completed
phase.started              { phase: "Establish test baseline" }
baseline.recorded
checkpoint.created         { completedPhase: "analyzing",     resumePhase: "planning" }
phase.completed
phase.started              { phase: "Create plan" }
plan.recorded
checkpoint.created         { completedPhase: "planning",      resumePhase: "implementing" }
phase.completed
phase.started              { phase: "Implement change" }
checkpoint.created         { completedPhase: "implementing",  resumePhase: "testing" }
phase.completed
phase.started              { phase: "Validate change" }
validation.recorded        { validation: "verified" | "fixed" }
checkpoint.created         { completedPhase: "testing",       resumePhase: "reviewing" }
phase.completed
phase.started              { phase: "Review patch" }
review.recorded            { reviewDecision: "approve", reviewLoop: 0, blockingCount: 0 }
checkpoint.created         { completedPhase: "reviewing",     resumePhase: "finalizing" }
phase.completed
phase.started              { phase: "Finalize" }
run.summarized             { reviewDecision: "approve", reviewLoops: 0 }
phase.completed
job.completed
```

Additional per-turn `checkpoint.created` rows may appear inside `implementing`; the assertion is on
the boundary rows, identified by `completedPhase` being present.

**Job row afterwards**

```text
status                completed
failure_category      null
review_mode           independent
max_review_loops      2
review_loops          0
review_decision       approve
review_blocking_count 0
```

**Negative assertions.** No `review.revision_requested`, no `review.limit_reached`, no
`review.skipped`, and the job never enters `revising`. Exactly one `review_report` artifact is
listed by `/api/jobs/:id/artifacts`.

## B. One revision, then approved

The loop going around once, which is the M8 demo. The scripted reviewer returns `revise` with one
blocking issue, then `approve`.

**Statuses**

```text
queued -> provisioning -> analyzing -> planning -> implementing -> testing -> reviewing
       -> revising -> testing -> reviewing -> finalizing -> completed
```

Both `reviewing -> revising` and `revising -> testing` are already legal edges. The second `testing`
is a real re-validation and not a replay: it stages the revised tree, re-selects targeted tests, and
compares against the same `analyzing` baseline.

**Projected events**, from `Review patch` onwards; everything before it is identical to run A.

```text
phase.started              { phase: "Review patch" }
review.recorded            { reviewDecision: "revise", reviewLoop: 0, blockingCount: >= 1 }
review.revision_requested  { reviewLoop: 0, reviewLoops: 1, maxReviewLoops: 2 }
checkpoint.created         { completedPhase: "reviewing",  resumePhase: "revising" }
phase.completed
phase.started              { phase: "Revise change" }
checkpoint.created         { completedPhase: "revising",   resumePhase: "testing" }
phase.completed
phase.started              { phase: "Validate change" }
validation.recorded
checkpoint.created         { completedPhase: "testing",    resumePhase: "reviewing" }
phase.completed
phase.started              { phase: "Review patch" }
review.recorded            { reviewDecision: "approve", reviewLoop: 1, blockingCount: 0 }
checkpoint.created         { completedPhase: "reviewing",  resumePhase: "finalizing" }
phase.completed
phase.started              { phase: "Finalize" }
run.summarized             { reviewDecision: "approve", reviewLoops: 1 }
phase.completed
job.completed
```

The `resumePhase` on the first `reviewing` boundary checkpoint is `revising` rather than
`finalizing`, and it is the single most important assertion in this run: a checkpoint that named
`finalizing` would let a crash during the revision skip the revision entirely and finalize a patch
its own reviewer rejected. See the obligations section.

**Job row afterwards**

```text
status                completed
review_loops          1
review_decision       approve
review_blocking_count 0
```

**Additional assertions.** Two `review_report` artifacts, in loop order. The second reviewer session
was given the first report as context, which is asserted through the fake: the scripted reviewer
records the context it was handed and the test checks that the previous report's summary appears in
it. Exactly two `validation.recorded` rows and two `phase.started` rows labelled `Validate change`;
`review_blocking_count` reflects the **last** verdict, not the worst one.

## C. Revised until the bound

`maxReviewLoops: 1`, and a scripted reviewer that returns `revise` every time. One revision is
spent, the second verdict has no budget behind it, and the job fails.

**Statuses**

```text
queued -> provisioning -> analyzing -> planning -> implementing -> testing -> reviewing
       -> revising -> testing -> reviewing -> failed
```

**Projected events**, from the first `Review patch`:

```text
phase.started              { phase: "Review patch" }
review.recorded            { reviewDecision: "revise", reviewLoop: 0, blockingCount: >= 1 }
review.revision_requested  { reviewLoop: 0, reviewLoops: 1, maxReviewLoops: 1 }
checkpoint.created         { completedPhase: "reviewing", resumePhase: "revising" }
phase.completed
phase.started              { phase: "Revise change" }
checkpoint.created         { completedPhase: "revising",  resumePhase: "testing" }
phase.completed
phase.started              { phase: "Validate change" }
validation.recorded
checkpoint.created         { completedPhase: "testing",   resumePhase: "reviewing" }
phase.completed
phase.started              { phase: "Review patch" }
review.recorded            { reviewDecision: "revise", reviewLoop: 1, blockingCount: >= 1 }
review.limit_reached       { reviewLoops: 1, maxReviewLoops: 1, failureCategory: "reviewer_rejection" }
job.failed                 { failureCategory: "reviewer_rejection" }
```

The second `reviewing` writes **no** `phase.completed` and **no** boundary checkpoint: the phase
threw, so the runner never reached `onPhaseComplete`. `job.failed` is written by the processor from
`reviewing`, which is why `ALLOWED_TRANSITIONS.reviewing` already lists `failed`.

**Job row afterwards**

```text
status                failed
failure_category      reviewer_rejection
failure_reason        contains the reviewer's summary
review_loops          1
review_decision       revise
review_blocking_count the last verdict's blocking count
```

**Additional assertions.** The `review_report` artifact of the rejecting verdict is present and
readable on the failed job - the whole trade in decision 4 rests on a rejection being attributable
to named findings afterwards. `run.summarized` is absent, because `finalizing` never ran. The BullMQ
message is in state `failed` with `attemptsMade` 1: `reviewer_rejection` is terminal, so it is
thrown as an `UnrecoverableError` and never retried.

## D. `reviewMode: "none"`

Created with `reviewMode: "none"`. The M7 workflow, and a timeline that says which of the two
reasons it skipped review.

**Statuses**

```text
queued -> provisioning -> analyzing -> planning -> implementing -> testing -> reviewing
       -> finalizing -> completed
```

The status walk is identical to run A. That is intentional: `none` is a branch inside the existing
pipeline rather than a second pipeline, so `reviewing` is still entered, still recorded, and still
checkpointed.

**Projected events**, from `Review patch`:

```text
phase.started              { phase: "Review patch" }
review.skipped             { reviewMode: "none" }
checkpoint.created         { completedPhase: "reviewing", resumePhase: "finalizing" }
phase.completed
phase.started              { phase: "Finalize" }
run.summarized             { reviewLoops: 0 }   // and no reviewDecision
phase.completed
job.completed
```

**Job row afterwards**

```text
status                completed
review_mode           none
review_loops          0
review_decision       null
review_blocking_count null
```

**Negative assertions.** No `review.recorded`, no `review_report` artifact, no reviewer session:
`agent.session_started` rows carrying `agentRole: "reviewer"` number zero. No model was called on
this job's behalf for review, which is the property `none` exists to buy.

## E. The session ends without submitting a verdict

A scripted reviewer session that runs turns, says JSON-shaped things, and never calls
`submit_review`. Mirrors `plan_not_produced` exactly.

**Statuses**

```text
queued -> provisioning -> analyzing -> planning -> implementing -> testing -> reviewing -> failed
```

**Projected events**, from `Review patch`:

```text
phase.started              { phase: "Review patch" }
job.failed                 { failureCategory: "review_not_produced" }
```

**Job row afterwards**

```text
status                failed
failure_category      review_not_produced
review_loops          0
review_decision       null
review_blocking_count null
```

**Negative assertions, and they are the whole point of this run.** No `review.recorded`, no
`review_report` artifact, no `review.revision_requested`, no `phase.completed` for `Review patch`,
no boundary checkpoint for `reviewing`, and above all the job does **not** reach `finalizing` or
`completed`. A missing verdict treated as an approval would be the one bug in this milestone nobody
would ever notice, so the test asserts the absence directly rather than only asserting the failure
category. The BullMQ message is `failed` with one attempt made.

## F. A crash during `revising`

The M6 recovery proof extended by one phase. Run B's script, with the first worker killed while the
revision session is in flight; a replacement worker claims the job after the sweeper clears the
lease.

**Statuses**

```text
queued -> provisioning -> analyzing -> planning -> implementing -> testing -> reviewing
       -> revising -> queued -> provisioning -> revising -> testing -> reviewing
       -> finalizing -> completed
```

The `revising -> queued` edge is the reclaim, and it is already legal. `provisioning -> revising` is
the resume edge, and it is the one `ALLOWED_TRANSITIONS.provisioning` has to gain in Stage 8.

**Projected events on the second attempt**

```text
job.reclaimed              { leaseOwner: <the dead worker> }
job.claimed                { to: "provisioning", attempt: 2 }
phase.started              { phase: "Provision sandbox" }
checkpoint.restored        { resumePhase: "revising", patchSha256: <verified> }
run.resumed                { resumePhase: "revising", attempt: 2 }
phase.completed
phase.started              { phase: "Revise change" }
checkpoint.created         { completedPhase: "revising", resumePhase: "testing" }
phase.completed
phase.started              { phase: "Validate change" }
...                        // identical to the tail of run B
job.completed
```

`checkpoint.restored` is written by `provisioning` before `phase.completed`; `run.resumed` is
written by the processor's `onPhaseComplete` after it. The replacement runs
`[provisioning, revising, testing, reviewing, finalizing]`, which is the suffix `planResume()` must
produce for a `revising` cursor - `revising` is not in `PHASE_TEMPLATE`, so this cannot come out of
index arithmetic.

**The assertions that make this run worth having**

```text
review_loops          1 on the replacement's job row, before and after the resumed revision
max_review_loops      unchanged
attempt_count         2
dispatch_generation   incremented by the reclaim
base_commit_sha       identical to the first attempt's
sandbox id            different from the first attempt's
```

`review_loops` staying at 1 across the crash is the entire content of decision 6. A replacement that
read the counter as 0 would hand the job two fresh revisions, which is the same class of bug as a
crash refunding an agent budget - and it would be invisible, because the run would still end green.
The test asserts the counter both immediately after the reclaim and on the completed job, so a
counter that is reset and then re-incremented cannot pass.

The second reviewer session must also see the first verdict: the previous `review_report` is read
from Postgres rather than from process memory, so a session running on a different worker gets the
same context. A test that only checked the counter would miss a resumed reviewer starting blind.

## What this contract deliberately does not pin down

- **The content of a verdict.** Whether a given diff deserves `approve` is the model's judgment and
  is not testable in CI. Every run above scripts the verdict; what is asserted is what Rivet does
  with one.
- **Token counts, costs, durations and turn counts.** They are recorded and bounded elsewhere; an
  acceptance sequence that asserted them would be asserting a property of the fake.
- **The number of `agent.*` and `command.*` rows.** Outside the projection, on purpose.
- **Whether the reviewer read any files.** `list_files`, `read` and `search_text` are available and
  the sandbox test proves the tool set is exactly four; a scripted session that reads nothing is
  still a valid session.
- **Wording.** Every `message` string is prose for a human. Assert `type` and `data`.

## Obligations this contract places on later stages

Writing the sequences down first surfaced three things the current code cannot express. None of them
is a change to Stage 0; all three are stated here so the stage that owns them cannot land without
noticing.

1. **A `reviewing` boundary checkpoint must be able to resume at `revising`.** `NEXT_PHASE` in
   `packages/core/src/checkpoints/checkpoint-store.ts` is a static map with
   `reviewing -> finalizing`, so a boundary checkpoint written after a verdict of `revise` would
   claim the job should resume at `finalizing`. That is not a cosmetic mislabel: it would let a
   crash during the revision finalize a patch the reviewer rejected. The resume phase for a
   completed `reviewing` has to follow the directive - `revising` when one was returned,
   `finalizing` otherwise - and runs B, C and F assert the resulting `resumePhase` directly.

2. **A turn checkpoint captured during `revising` must resume at `revising`.**
   `resumePhaseForCheckpoint` hard-codes `agent_turn -> implementing`. Stage 7 reuses
   `implementing-phase.ts`'s session plumbing, turn checkpoints included, so without a change a
   revision interrupted mid-turn would resume as a fresh **implementation** session: the review's
   findings would be dropped and the job would re-enter the pipeline before its own reviewer ever
   looked at the result. Run F is specified against the phase-boundary checkpoint written when
   `reviewing` completed, so it passes either way, and this obligation is therefore stated rather
   than asserted. Stage 7 should either carry the phase on the turn checkpoint or decline to capture
   turn checkpoints in `revising`, and say which in a comment.

3. **`run.summarized` gains `reviewDecision` and `reviewLoops`.** Runs A, B and D assert them. On a
   job that skipped review, `reviewLoops` is 0 and `reviewDecision` is absent rather than null: "no
   reviewer looked at this" and "a reviewer had nothing to say" are different facts, and the same
   argument `finalizing` already makes about a missing validation record applies unchanged.

## The Stage 0 fixture task

`docs/plans/milestone-8.md` asks for a task in `rivet-fixture-node` "whose obvious implementation
passes the test suite while missing an edge case the issue text names". The fixture repository is a
separate public repository and Rivet clones it at `main`, so a task for it is written down in this
repository and the repository itself is left alone. The tasks now live in
`apps/worker/src/demo-tasks.ts`, selected by `RIVET_DEMO_TASK`:

| id                       | used by                   | what it proves                                  |
| ------------------------ | ------------------------- | ----------------------------------------------- |
| `bulk-discount-boundary` | the default, M5 and M7    | the pipeline works end to end on a one-line bug |
| `multi-line-order`       | `RIVET_DEMO_TASK=...`, M8 | validation is green and the verdict is `revise` |

`multi-line-order` asks for `orderTotalCents(lines)` **and** for the seeded `>` bug to be fixed. The
pairing is load-bearing in both directions:

- The fix is what makes the run reach `reviewing` at all. Without it the suite is still red after
  the session, the test check compares as `unresolved`, and `testing` fails the job with
  `validation_failed` before any reviewer runs.
- The new function is what makes the run interesting. Nothing in the repository tests it, so
  whatever the session writes, the test check is `fixed`, typecheck and lint are `verified`, and the
  aggregate outcome is green. The issue text names two things the obvious implementation gets
  wrong - rounding the discount once over the whole order rather than per line, and an empty order
  totalling 0 rather than throwing - and both are visible in the diff the reviewer is handed.

That is the shape M8 needs: a job where M7 has nothing left to say and the correct answer is still
`revise`. It is also why the demo command keeps its name. Review is the default path, so
`RIVET_DEMO_TASK=multi-line-order pnpm demo:job` is one real job that is revised once and then
approved, and the default task remains the cheap green run that M5 and M7 already document.

No change is required in `rivet-fixture-node` itself, and that is deliberate: the external
repository is the first entry in M10's evaluation corpus, and a fixture that grows a new module per
milestone stops being the deliberately boring thing it was built to be.
