# Milestone 8: a guided tour of independent Pi review

This is the educational record for Milestone 8. The plan in
[`docs/plans/milestone-8.md`](plans/milestone-8.md) describes the intended design, and the
acceptance contract in [`docs/plans/milestone-8-acceptance.md`](plans/milestone-8-acceptance.md)
describes the observable behavior. This guide explains how the implementation fulfills that design,
why the important decisions were made, how to trace a job through the system, and where to look when
something goes wrong.

**Status: implementation complete.** The six scripted acceptance runs, the real Docker reviewer
check, the offline suite, the streaming suite, the production build, and the real `multi-line-order`
demo have passed. The real demo's model approved its first patch, so it did not happen to exercise a
revision. The deterministic integration run B is the authoritative proof of the revision loop.

---

## Part 0. The one idea

Milestone 7 answered a deterministic question:

> Did the coding session make the repository measurably worse?

Milestone 8 adds a second question that exit codes cannot answer:

> Does the patch actually solve the task, and is the change complete and appropriate?

The workflow is now:

```text
implementation
    |
    v
validation: targeted test, full test, typecheck, lint
    |
    v
independent read-only review
    |
    +--> approve ---> finalization
    |
    +--> revise ---> revision session
                         |
                         v
                      validation again
                         |
                         v
                      review again
```

The reviewer is a separate Pi session. It receives durable evidence about the job, returns a
structured verdict, and has no shell, edit, or write tool. If it asks for a revision, Rivet inserts
a real `revising` phase, validates the new workspace, and gives the result to a fresh reviewer
session. Rivet, not the model, owns the maximum number of revision loops.

The core product lesson is that model judgment is still made durable and deterministic at the
workflow boundary:

- the model decides `approve` or `revise`
- the contract validates the shape of that decision
- the database records the decision and loop count
- the phase decides whether to finalize, cycle, or fail
- the runner only knows how to execute a validated phase directive

---

## Part 1. What changed from M7

### Before M8

The end of a normal job looked like this:

```text
implementing -> testing -> finalizing -> completed
```

Validation could record that tests passed, typecheck passed, and lint passed. It could not tell us
that an implementation missed a requirement that had no test, added a weak test, changed an
unrelated file, or solved only half of the issue.

### After M8

The default path is:

```text
implementing -> testing -> reviewing -> finalizing -> completed
```

A blocking review creates a cycle:

```text
reviewing -> revising -> testing -> reviewing
```

The cycle is not hidden inside a long review function. Every phase appears in the status history,
gets its own start and completion events, and can be checkpointed or recovered independently.

### New durable vocabulary

| Area               | Added in M8                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Job columns        | `review_mode`, `max_review_loops`, `review_loops`, `review_decision`, `review_blocking_count` |
| Agent role         | `reviewer`                                                                                    |
| Reviewer tools     | `list_files`, `read`, `search_text`, `submit_review`                                          |
| Artifact           | `review_report`                                                                               |
| Events             | `review.recorded`, `review.revision_requested`, `review.limit_reached`, `review.skipped`      |
| Failure categories | `review_not_produced`, `reviewer_rejection`                                                   |
| Workflow phase     | directive-only `revising`                                                                     |
| Closing summary    | `run.summarized.data.reviewLoops` and optional `reviewDecision`                               |

No new HTTP endpoint was needed. Review reports use the existing artifact list and artifact content
routes.

---

## Part 2. The implementation history

M8 was implemented in small, reviewable commits. Reading these commits in order is a useful way to
understand the dependency graph:

```text
ffcf35e  docs: define milestone 8 acceptance contract and review fixture task
cb1c4ea  feat: define the review report contract
8edff5d  feat: persist review mode and loop accounting on jobs
4f0e01d  feat: add the reviewer role to the coding agent port
b887e32  feat: give the Pi adapter a read-only reviewer session
a447ea2  feat: let a phase cycle the pipeline queue
b3d53fe  feat: implement the independent reviewing phase
f7906dd  feat: implement the revising phase
3d894ca  feat: complete milestone 8 review orchestration config
b18fd0e  feat: render independent review results in the web UI
e50fe8e  test: prove milestone 8 review pipeline
```

The dependency order matters:

1. The acceptance contract defines observable behavior before implementation.
2. The report schema and database columns give later code a durable vocabulary.
3. The agent port and adapter make the reviewer capability-safe.
4. The runner can then express a cycle without knowing what a review means.
5. The phase bodies use the contracts and the cycle mechanism.
6. Recovery and configuration make the behavior stable across workers.
7. The UI and verification suites expose the result to humans.

Useful commands when studying a change:

```bash
git show --stat b3d53fe
git show b3d53fe -- packages/core/src/pipeline/reviewing-phase.ts
git log --oneline --reverse 6ca8fec..HEAD
```

---

## Part 3. Recommended reading path

Read these files in this order. It follows one review decision from its wire contract to the job
page:

| #   | File                                                | What it teaches                                         |
| --- | --------------------------------------------------- | ------------------------------------------------------- |
| 1   | `packages/contracts/src/review-report.ts`           | Review mode, verdict schema, categories, canonical JSON |
| 2   | `packages/contracts/src/job-event.ts`               | Event and failure vocabulary, event data fields         |
| 3   | `packages/database/src/schema/job.ts`               | Durable review columns                                  |
| 4   | `packages/core/src/jobs/review.ts`                  | Lease-fenced review writer                              |
| 5   | `packages/core/src/agent/coding-agent.ts`           | Reviewer port and tool boundary                         |
| 6   | `packages/agent/src/pi-agent.ts`                    | Pi role wiring and active-tool assertion                |
| 7   | `packages/core/src/pipeline/run-pipeline.ts`        | Dynamic queue and phase directives                      |
| 8   | `packages/core/src/pipeline/reviewing-phase.ts`     | Reviewer session, report persistence, decision logic    |
| 9   | `packages/core/src/pipeline/revising-phase.ts`      | Revision context and implementer session                |
| 10  | `packages/core/src/checkpoints/checkpoint-store.ts` | Legal recovery cursors                                  |
| 11  | `packages/core/src/pipeline/agent-session.ts`       | Turn checkpoints for implementation and revision        |
| 12  | `apps/worker/src/processor.ts`                      | Boundary checkpoint selection and recovery wiring       |
| 13  | `apps/web/components/review-panel.tsx`              | Server-rendered findings and decision panel             |
| 14  | `apps/worker/tests/integration/review.int.test.ts`  | Acceptance runs A through F                             |
| 15  | `apps/worker/tests/sandbox/pipeline.sbx.test.ts`    | Real Docker and diff immutability                       |

If you only have twenty minutes, read files 1, 5, 7, 8, 9, 10, and 14.

---

## Part 4. The review report contract

The contract lives in `packages/contracts/src/review-report.ts`. It is the boundary between model
output and workflow state.

### Review mode and decision

```ts
reviewMode: "independent" | "none";
reviewDecision: "approve" | "revise" | null;
```

`reviewMode` is stored on the job, not read as a worker kill switch. A job created with
`independent` is reviewed even if another worker later claims it. A job created with `none` still
enters the `reviewing` status, but records `review.skipped` and does not start a reviewer session.

`reviewDecision` is nullable because a job can fail before a reviewer answers, for example when the
session ends without calling `submit_review`.

### A finding

```ts
type ReviewIssue = {
  title: string;
  detail: string;
  paths: string[];
  category:
    | "correctness"
    | "incomplete"
    | "concurrency"
    | "security"
    | "edge_case"
    | "unnecessary_change"
    | "weak_test"
    | "compatibility";
};
```

The category list is closed deliberately. A closed vocabulary lets the UI group findings and gives
future evaluation code something stable to count.

### The whole report

```ts
type ReviewReport = {
  decision: "approve" | "revise";
  blockingIssues: ReviewIssue[];
  nonBlockingIssues: ReviewIssue[];
  confidence: number;
  summary: string;
};
```

The schema is strict and bounded:

- issue titles are at most 200 characters
- issue details and summaries are at most 4,000 characters
- each issue can name at most 20 paths
- each issue list can contain at most 20 findings
- confidence must be between 0 and 1
- `revise` requires at least one blocking issue
- `approve` requires zero blocking issues

The cross-field rules belong in the schema, not in the phase. The model receives a tool error while
it can still correct its answer. Waiting until the phase ends would turn a recoverable model mistake
into `review_not_produced`.

`parseReviewReport()` and `serializeReviewReport()` normalize the object into a canonical JSON
shape. This matters because artifacts are read by another process after recovery, and stable JSON
makes tests and debugging easier.

---

## Part 5. Job state and persistence

The M8 migration is `packages/database/drizzle/0006_sharp_romulus.sql`:

```sql
review_mode text not null default 'independent'
max_review_loops integer not null default 2
review_loops integer not null default 0
review_decision text
review_blocking_count integer
```

The columns have different responsibilities:

| Column                  | Meaning                                             |
| ----------------------- | --------------------------------------------------- |
| `review_mode`           | Whether this job requests an independent review     |
| `max_review_loops`      | The job's maximum number of revisions               |
| `review_loops`          | Revisions already spent, cumulative across attempts |
| `review_decision`       | The last persisted verdict                          |
| `review_blocking_count` | Blocking findings in the last persisted verdict     |

The counter belongs to the job rather than the worker attempt. If worker A spends one revision and
then dies, worker B must see `review_loops = 1`. Otherwise a crash would refund the review budget.

### `recordReview()`

`packages/core/src/jobs/review.ts` contains the only review-specific job writer. It updates only
review columns and is fenced by both:

```text
jobs.id = jobId
jobs.lease_owner = leaseOwner
jobs.lease_expires_at > now()
```

It returns `false` when the worker has lost its lease. The phase context converts that loss into the
normal lease-loss behavior rather than allowing a stale worker to publish a verdict into a new
attempt.

This follows the same invariant as agent usage and provisioning facts:

> `transitionJob()` is the only writer of `jobs.status`; fact-specific writers may update their own
> columns, but never status.

The reviewer phase also updates its in-memory `ctx.job` after a successful `recordReview()`. That is
needed because a revision cycle can enter another reviewer phase in the same attempt without
reloading the job row.

---

## Part 6. The reviewer capability boundary

The reviewer is not an implementer with a nicer prompt. It is a distinct role with a distinct
capability set.

```text
implementer: bash, edit, read, write
planner:     list_files, read, search_text, submit_plan
reviewer:    list_files, read, search_text, submit_review
```

The Pi adapter creates the role-specific toolbox and then checks `session.getActiveToolNames()`
after the session is constructed. If Pi, a provider, or a future harness upgrade hands the reviewer
a shell or edit tool, the session fails rather than relying on instruction-following.

### Why no shell?

A shell can modify the repository. If the reviewer could edit the workspace, the object being judged
could change after validation and before the verdict. The review would no longer be independent, and
the final patch could differ from the one the tests validated.

The sandbox test measures this property rather than trusting the prompt:

1. capture the staged diff when validation records it
2. run the real reviewer path in a Docker container
3. capture the staged diff again before container destruction
4. compare the bytes exactly

### Why `submit_review` is different

`submit_review` is a worker-side capability, not a repository mutation capability. It validates the
structured value and hands it to the phase. It cannot read, write, or execute anything. A
JSON-shaped assistant message is not a review. Only a successful `submit_review` call is durable
review output.

The fake agent supports the same distinction, which lets unit and integration tests exercise the
workflow without a model key:

```ts
new FakeCodingAgent({
  reviewerScript: { review: approvingReview() },
});

new FakeCodingAgent({
  reviewerScript: [{ review: revisingReview() }, { review: approvingReview() }],
});

new FakeCodingAgent({
  reviewerScript: { review: null },
});
```

The last form ends without a verdict and must fail with `review_not_produced`.

---

## Part 7. What the reviewer sees

The reviewer session is fresh, but its context is durable. `reviewing-phase.ts` builds it from the
job and artifacts already produced by earlier phases:

```text
issue title and description
implementation plan
implementation summary
diff and diff stat
validation report
previous review report, when this is a later loop
```

This context comes from Postgres and the sandbox, not from the previous model session's memory. That
is required for recovery: a replacement worker may run the next reviewer in a new process and a new
container.

The reviewer can inspect repository state through fixed commands:

```text
git ls-files
sandbox.getFile(path)
git grep -n --no-color -e <query> -- .
```

The commands are owned by the phase and use the same command ledger and output caps as other
sandbox-backed tools. The reviewer does not rerun tests. M7 already ran deterministic checks and the
review context includes their parsed results. Re-running them would duplicate a deterministic fact
and increase model/session cost without adding independent judgment.

On later loops, `readLatestReviewReport()` supplies the previous report. This makes the second
reviewer aware of the original blocking findings without reusing the original conversation.

---

## Part 8. The dynamic pipeline queue

Before M8, `runPipeline()` could walk a fixed phase array once. A review loop needs to insert phases
at runtime. The runner now accepts:

```ts
type PhaseDirective = { kind: "cycle"; phases: readonly Phase[] } | undefined;
```

The base queue is still:

```text
provisioning, analyzing, planning, implementing, testing, reviewing, finalizing
```

`revising` is not in that template. `buildPipeline()` creates it as a directive-reachable phase and
attaches it to the pipeline's known phase set. When reviewing returns:

```ts
{
  kind: "cycle",
  phases: [revising, testing, reviewing],
}
```

the runner unshifts those exact phase objects ahead of the remaining `finalizing` phase:

```text
before: testing, reviewing, finalizing
cycle:  revising, testing, reviewing
result: revising, testing, reviewing, finalizing
```

The runner checks phase identity, not only status. A directive cannot manufacture a new object with
a known status and bypass the configured body.

The runner does not own the review counter. That would make the counter an attempt-local fact. The
reviewing phase reads durable `review_loops`, decides whether there is budget, persists the new
count, and only then returns the directive.

This separation keeps the runner generic:

- the runner knows queue mechanics and cancellation
- the reviewing phase knows verdicts and bounds
- the processor knows leases and checkpoints
- the database knows durable state

---

## Part 9. Reviewing phase decision logic

The central code is `packages/core/src/pipeline/reviewing-phase.ts`.

### Step 1: respect job mode

If `ctx.job.reviewMode === "none"`, the phase writes:

```text
review.skipped { reviewMode: "none" }
```

It does not create a reviewer session, report artifact, or review decision. The phase returns
`undefined`, so the runner continues to finalization.

`RIVET_AGENT=off` is different. In that configuration no agent body is wired at all, so `reviewing`
is a simulated sleep and writes no review event. This distinction is useful when debugging:

- `review.skipped` means the job intentionally opted out
- no review event means this worker had no agent capability

### Step 2: construct the reviewer toolbox and context

The phase builds a `ReviewerAgentToolbox`, a `CodingAgentSpec` with role `reviewer`, and a fresh
session. `submitReview` accepts one valid report only. A second submission gets a tool error.

### Step 3: run the session

`runAgentSession()` handles the shared concerns:

- turn and model budgets
- cumulative usage persistence
- cancellation and deadline signals
- provider failure classification
- agent event recording

The reviewer role uses the same session plumbing but a different capability boundary.

### Step 4: reject missing verdicts

If no valid report was submitted, the phase throws `ReviewNotProducedError`. The processor
classifies this as terminal `review_not_produced`. The job does not enter finalization.

This is an important safety rule. A silent reviewer must not accidentally become an approval.

### Step 5: persist the report and verdict event

The phase writes the complete `review_report` artifact first, then writes `review.recorded` with:

```ts
{
  artifactId,
  artifactType: "review_report",
  agentRole: "reviewer",
  reviewDecision,
  reviewLoop,
  blockingCount,
  nonBlockingCount,
  confidence,
}
```

The artifact-first order means the event's `artifactId` always resolves to content.

### Step 6: decide what happens next

The phase applies the deterministic decision table:

| Verdict   | Budget                            | Action                                                                       |
| --------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `approve` | any                               | persist decision and continue to finalization                                |
| `revise`  | `review_loops < max_review_loops` | increment count, emit `review.revision_requested`, return cycle              |
| `revise`  | count reached bound               | persist verdict, emit `review.limit_reached`, throw `ReviewerRejectionError` |

`ReviewerRejectionError` is terminal. Retrying the same job message would not create a new model
opinion that fixes a still-rejected patch, and would spend another attempt without changing the
review loop accounting.

---

## Part 10. Revising phase

The revision phase is in `packages/core/src/pipeline/revising-phase.ts`.

It deliberately reuses the implementer role. A revision needs `bash`, `edit`, `read`, and `write`,
while a reviewer must not have those capabilities. Creating a fourth special tool set would add
complexity without a security benefit.

The phase:

1. reads the latest durable review report
2. verifies that it says `revise` and contains a blocking issue
3. builds the normal implementer context
4. appends a revision brief containing blocking and non-blocking findings
5. runs the implementer session
6. returns `undefined`

The runner then continues with the directive's next phase, which is deterministic validation.

The revision brief explicitly says:

- address every blocking finding
- do not re-litigate the settled implementation plan
- make the smallest evidence-based correction
- add or update tests where needed
- do not discard the existing patch and start over

The phase does not write a new artifact or decide whether the revision succeeded. Validation and the
next independent review make those decisions.

---

## Part 11. Checkpoints and recovery

M8 has three recovery points that must agree:

```text
reviewing boundary with approve  -> finalizing
reviewing boundary with revise  -> revising
revising turn checkpoint         -> revising
revising boundary                -> testing
```

### Review boundary checkpoint

Normally `NEXT_PHASE` says:

```text
reviewing -> finalizing
```

That is correct for approval but wrong for a blocking review. `apps/worker/src/processor.ts`
examines the directive before writing the boundary checkpoint. When the first inserted phase is
`revising`, it writes:

```text
checkpoint.created {
  completedPhase: "reviewing",
  resumePhase: "revising",
}
```

The checkpoint is written before `phase.completed`. If the worker dies after the review verdict but
before the phase is acknowledged, recovery replays the review boundary rather than skipping it.

### Revision turn checkpoint

`revising` reuses implementer session plumbing, including per-turn workspace checkpoints. The
session runner stamps those checkpoints with `resumePhase: "revising"` instead of the normal
`resumePhase: "implementing"`.

Without this distinction, a crash in the middle of a revision would restore the workspace and start
a fresh implementation session. The reviewer findings would disappear from the context and the job
could skip its intended correction.

### Recovery suffix

`resume-plan.ts` explicitly inserts `revising` because it is absent from `PHASE_TEMPLATE`:

```text
checkpoint says resume revising
    -> provisioning, revising, testing, reviewing, finalizing
```

Provisioning restores the patch into a new container, verifies the checksum, then the processor
writes `checkpoint.restored` and `run.resumed`. The replacement sees the same:

```text
review_loops = 1
max_review_loops = 2
```

The crash test asserts this before the resumed revision completes. A replacement cannot refund the
loop budget.

---

## Part 12. Finalization and the closing event

`finalizing-phase.ts` already persisted the implementation summary and validation outcome. M8
extends `run.summarized` with review fields:

```ts
{
  reviewLoops: 0,
  reviewDecision: "approve",
}
```

For `reviewMode: "none"`:

```ts
{
  reviewLoops: 0,
  // reviewDecision is intentionally absent
}
```

Absence is meaningful. It distinguishes:

- no reviewer was requested or no reviewer ran
- a reviewer ran and approved
- a reviewer ran and requested a revision

The event is the durable closing summary consumed by the timeline and any later reporting system.

---

## Part 13. The web surface

M8 does not add a new API route. Existing artifact and event routes are enough.

### Review panel

`apps/web/components/review-panel.tsx` renders:

- decision
- confidence
- loop count
- blocking findings
- non-blocking findings
- finding categories and paths

The server page loads the latest review artifact and passes it to the panel. Malformed or missing
artifacts are handled as data-quality cases rather than crashing the page.

### Timeline

`apps/web/lib/review-events.ts` maps the four review events to human-readable timeline entries.
`review.revision_requested` is especially useful because repeated `testing` and `reviewing` phases
otherwise look like accidental duplicates.

### Artifacts

The artifact panel now recognizes `review_report`. The existing endpoints provide metadata and
content:

```text
GET /api/jobs/:id/artifacts
GET /api/jobs/:id/artifacts/:artifactId
```

The browser never receives checkpoint payloads. Review reports are safe to display because they are
bounded structured artifacts, while workspace patches remain an internal recovery mechanism.

---

## Part 14. The acceptance runs

`apps/worker/tests/integration/review.int.test.ts` runs the real Postgres, Redis, BullMQ, and
production processor. Only the sandbox and coding-agent boundaries are scripted.

| Run | Script                      | Expected result                 | What it protects                      |
| --- | --------------------------- | ------------------------------- | ------------------------------------- |
| A   | approval                    | `completed`                     | default review path and finalization  |
| B   | revise, then approve        | `completed`, `review_loops = 1` | dynamic cycle and second validation   |
| C   | revise until bound          | `failed`, `reviewer_rejection`  | Rivet-owned loop enforcement          |
| D   | `reviewMode: "none"`        | `completed`                     | job-level opt out and skipped event   |
| E   | no submitted verdict        | `failed`, `review_not_produced` | missing verdict is not approval       |
| F   | kill worker during revision | `completed`                     | recovery keeps loop count and context |

The tests intentionally assert a projection of the event stream. They pin durable phase, review,
checkpoint, summary, and terminal events, while leaving exact `agent.*` and `command.*` counts
flexible. That keeps the tests about workflow guarantees rather than fake-session implementation
details.

### What to inspect in run B

The most important rows are:

```text
review.recorded              reviewDecision: revise, reviewLoop: 0
review.revision_requested    reviewLoops: 1
checkpoint.created           completedPhase: reviewing, resumePhase: revising
phase.started                Revise change
checkpoint.created           completedPhase: revising, resumePhase: testing
phase.started                Validate change
phase.started                Review patch
review.recorded              reviewDecision: approve, reviewLoop: 1
run.summarized               reviewLoops: 1, reviewDecision: approve
```

If the first checkpoint says `finalizing`, recovery can skip the revision. If the second validation
is absent, the implementation is trusting a reviewer without checking the changed workspace.

### What to inspect in run C

The rejecting review still has a readable `review_report` artifact. The second review writes
`review.limit_reached` and then fails the job. There is no `phase.completed` for the failing review
and no `run.summarized`, because finalization never ran.

---

## Part 15. Sandbox proof of read-only review

The sandbox acceptance case is in `apps/worker/tests/sandbox/pipeline.sbx.test.ts`.

`ReviewDiffProbe` wraps the real `DockerSandboxProvider` and observes the staged diff at two points:

```text
before: validation's git diff --cached
reviewer session runs
 after: immediately before container destruction
```

The test asserts:

- the reviewer session event names exactly four tools
- `review.recorded` exists
- `before` and `after` are byte-identical
- the diff contains the implementer's change

This does not prove that a model made a good judgment. It proves the infrastructure did not give the
model a capability that can mutate the object it was judging.

The test uses `FakeCodingAgent` because CI and the sandbox suite must not depend on a provider key.
The real Pi adapter's active-tool assertion is unit tested separately, and the real end-to-end demo
exercises Pi itself.

---

## Part 16. Verification ladder

Use the smallest layer that can answer the question you are investigating.

### Level 1: focused offline tests

```bash
pnpm --filter @rivet/contracts test
pnpm --filter @rivet/agent test
pnpm --filter @rivet/core test
pnpm --filter @rivet/web test
```

These need no database, Redis, Docker, or model key. They cover schemas, tool sets, runner cycles,
phase decisions, resume suffixes, review context, and UI presentation.

### Level 2: repository offline gate

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

This gate must work without `DATABASE_URL`, `REDIS_URL`, or a Docker daemon. If an import starts a
client or opens a connection, the lazy-boundary invariant has been broken.

### Level 3: integration acceptance

Start local Postgres and Redis, then run:

```bash
pnpm test:integration
```

The suite refuses remote databases by default and truncates local job tables. It uses scripted
reviewer sessions so the six acceptance outcomes are deterministic.

To focus on M8:

```bash
pnpm --filter @rivet/worker exec vitest run \
  --config vitest.integration.config.ts \
  tests/integration/review.int.test.ts
```

### Level 4: Docker sandbox acceptance

With Docker, Postgres, and Redis running:

```bash
pnpm test:sandbox
```

To focus on the read-only reviewer:

```bash
pnpm --filter @rivet/worker test:sandbox \
  tests/sandbox/pipeline.sbx.test.ts \
  -t "read-only tools and preserves the diff byte-for-byte"
```

### Level 5: web streaming regression

```bash
pnpm test:streaming
```

M8 adds timeline event types, so the existing SSE suite is part of the release gate even though it
does not need Redis or Docker.

### Level 6: real job

Requirements:

- local Postgres
- local Redis
- Docker
- `OPENROUTER_API_KEY` in `.env.local`
- `RIVET_SANDBOX=docker`
- `RIVET_AGENT=pi`

Run:

```bash
RIVET_DEMO_TASK=multi-line-order pnpm demo:job
```

The command clones the public `rivet-fixture-node` repository, starts a real worker, runs planning,
implementation, validation, review, and finalization, then prints the durable artifacts.

The model may approve on the first review or request a revision. That variability is expected from a
real model. Run B is the deterministic revision proof.

### Complete M8 release gate

```bash
pnpm test
pnpm test:integration
pnpm test:sandbox
pnpm test:streaming
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
git diff --check
```

For a final live check, run the demo with `RIVET_DEMO_TASK=multi-line-order`. Stop other workers
using the same queue before running a demo, or an unrelated worker may claim the job.

---

## Part 17. Debugging guide

### The job enters `reviewing` but no reviewer session appears

Check the job row first:

```text
review_mode = none
```

means the job intentionally skipped review. A worker configured with `RIVET_AGENT=off` also has no
reviewer session, but it will not emit `review.skipped` because the entire agent phase is simulated.

If the job says `independent` and has an agent, inspect `agent.session_started` for
`agentRole: "reviewer"`. If it is absent, inspect the worker's `RIVET_AGENT` mode and the pipeline
construction in `apps/worker/src/index.ts`.

### The job fails with `review_not_produced`

This means the reviewer session ended without a successful `submit_review` call. Check:

1. `agent.session_ended` for provider or timeout errors
2. `agent.tool_completed` for a failed `submit_review`
3. the reviewer context and model output
4. whether the report violated a schema rule

Do not change this failure into approval. A missing verdict is an unsafe outcome.

### The job fails with `reviewer_rejection`

Inspect:

```text
review.recorded
review.limit_reached
review_report artifact
jobs.review_loops
jobs.max_review_loops
```

The failure is terminal by design. Read the report before changing the bound. If the reviewer is
wrong, `reviewMode: "none"` is the per-job escape hatch while the reviewer prompt or schema is
improved.

### A revision is followed immediately by finalization

Inspect the reviewing boundary checkpoint. It must say:

```text
completedPhase: reviewing
resumePhase: revising
```

The processor's directive-aware checkpoint selection is the first place to look. Then check that the
directive contains the configured identity of `revising`, not a newly constructed phase object.

### A recovered revision starts as implementation

Inspect the turn checkpoint:

```text
kind: agent_turn
resumePhase: revising
```

Then inspect `agent-session.ts` and `resumePhaseForCheckpoint()`. A revision turn accidentally
stamped as `implementing` loses its review brief after recovery.

### `review_loops` goes back to zero after a crash

Check that `recordReview()` committed before the worker died and that the replacement read the same
job row. Confirm the reclaim changed `dispatch_generation` and that the replacement did not create a
new job. The counter is job state, not a process variable.

### The reviewer changed the diff

Inspect the sandbox test's before and after values. Then verify the reviewer tool names in
`agent.session_started`. The reviewer must not have `bash`, `edit`, or `write`. If the active tool
assertion passes but the diff changes, inspect a worker-side helper that may be mutating the
workspace, not only the model tools.

### `run.summarized` has no review fields

Check that finalization reads the claimed job row after `recordReview()` and that the job's review
columns are part of `JobDetail`. For `reviewMode: "none"`, `reviewLoops: 0` should exist while
`reviewDecision` should be absent. For an approval or revision, both fields should be present.

### The real demo approves immediately

That is not a failure. A real model may implement every requirement and receive an approval on its
first review. It proves the live reviewer path, but it does not prove the revision branch in that
specific run. Use the scripted integration run B for deterministic loop coverage.

### The review panel is empty

Check whether the job actually has a `review_report` artifact. The following cases should not have
one:

- `reviewMode: "none"`
- `RIVET_AGENT=off`
- `review_not_produced`
- a job that failed before reviewing

If the artifact exists, inspect its canonical JSON through the artifact endpoint and then check the
web parser in `apps/web/lib/review-report.ts`.

---

## Part 18. Design decisions to preserve

### Keep review independent

Do not turn the implementer into a self-reviewer. A fresh session reduces anchoring and makes the
review a separate capability boundary. M10 can measure whether that improves outcomes; M8 only makes
the experiment possible.

### Keep the report structured

Do not replace `ReviewReport` with free-form text. The workflow needs a safe decision, bounded
findings, stable categories, and a durable artifact. Human prose remains in `summary` and `detail`.

### Keep the loop in durable job state

Do not put a counter in `runPipeline()`, `reviewingPhase()` local state, or a worker environment
variable. Those are all vulnerable to process death or cross-worker disagreement.

### Keep validation after every revision

A reviewer can request a code change, but only validation can tell us whether the new workspace
still passes deterministic checks. The cycle must remain:

```text
review -> revise -> validate -> review
```

not:

```text
review -> revise -> finalize
```

### Keep the reviewer away from the shell

Prompt instructions are not a security boundary. The active-tool assertion and the byte-identical
sandbox check are the important protections.

### Keep finalization report-aware

`run.summarized` is the closing event consumed by humans and later automation. It must say what
validation found and whether review approved, revised, or was skipped.

---

## Part 19. What remains, and the M9 handoff

There is no blocking M8 implementation gap in the automated acceptance suite. The remaining items
are follow-ups or limitations:

1. **Live demo revision is not deterministic.** The observed real demo was approved on the first
   loop. This is expected model variability. If the project requires the exact demo transcript to
   contain one revision, add a deterministic demo-only reviewer scenario or a fixture task that
   reliably exposes an untested requirement. Do not weaken the scripted B acceptance run.
2. **Reviewer quality is unmeasured.** M8 records judgments but does not compare review against no
   review. That belongs to M10's evaluation harness.
3. **Finalization still uses replay recovery.** M9 introduces external GitHub side effects, so its
   branch, commit, and push phases must choose an explicit external-effect recovery policy rather
   than inheriting replay by accident.
4. **The Docker bridge network is not a production isolation boundary.** The architecture still
   needs stronger sandboxing and egress controls before untrusted public use.
5. **Model costs can multiply.** A job may run several model sessions and several validation cycles.
   Existing cumulative budgets and the review bound limit this, but M11 and M10 should expose the
   resulting latency and cost.

The next milestone can begin. M9 should build on the M8 invariant:

```text
only an approved, completed validation and review run may create GitHub side effects
```

The first M9 design questions are:

- Which phase owns branch creation, commit, push, and pull request creation?
- Which external calls need idempotency receipts?
- What does recovery do after a GitHub call succeeds but the worker dies before recording it?
- Does `finalizing` remain the right place for the first external effect, or should M9 add an
  explicit side-effect phase?
- What durable evidence proves that the review approved the exact commit being opened as a PR?

---

## Part 20. Suggested learning exercises

1. Change the default `maxReviewLoops` to `1` and trace how runs B and C change.
2. Add a new review category. Follow it through the contract, UI grouping, tests, and guide.
3. Make the fake reviewer submit an invalid `approve` report containing a blocking issue. Observe
   the tool validation error and verify the session can correct it.
4. Kill the worker after `review.revision_requested` but before the revision begins. Inspect the
   boundary checkpoint and recovery suffix.
5. Kill the worker during a revision turn. Confirm the restored session is `revising`, not
   `implementing`.
6. Temporarily give the reviewer a shell in a test-only branch. Watch the Pi active-tool assertion
   and the sandbox diff probe fail.
7. Add a UI link from a `review.recorded` timeline event directly to its `review_report` artifact.
8. Design an M10 benchmark row that compares the same task with `reviewMode: "independent"` and
   `reviewMode: "none"` without changing the task or fixture.

Each exercise changes one boundary. That is the best way to learn this system: follow one fact from
model output, through a schema, into a database row, event, artifact, checkpoint, recovery path, and
screen.
