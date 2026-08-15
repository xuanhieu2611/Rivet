# Milestone 8: Independent Pi review session

**Status: complete.**

M8 is the first milestone where a job's outcome depends on a model's judgment rather than on an exit
code. M7 made validation deterministic: a check either regressed or it did not, and no model is
consulted. A green validation report says the patch did not break anything it can measure. It says
nothing about whether the patch solves the issue, whether the tests it added are worth anything, or
whether it quietly changed six files it had no business touching. That is the gap this milestone
closes, with a second Pi session that reads the diff and returns a structured verdict, and with
deterministic workflow code that decides what to do with the verdict.

The deliverable is the workflow, not an argument about multi-agent architecture:

```text
implementation
-> deterministic validation
-> independent review
-> revise if needed
-> validate again
-> review again
-> finalize
```

That is the default product path and the demo path. Review is on by default because a complete
autonomous engineering workflow includes review, not because M8 is trying to prove that a second
agent beats a single one. Whether the reviewer measurably improves task success is a real question
with a real answer, and it is an optional experiment in M10 once the benchmark harness exists. M8
builds no comparison machinery and no second pipeline.

The PRD sections that bind this milestone are §6.8, §12.4, Phase H in §11, and the M8 checklist. Two
of them say the same thing twice, which is worth reading as emphasis rather than duplication:
read-only is enforced by which sandbox-backed tools the reviewer is handed, not by asking the
reviewer to behave, and the maximum review loop count is enforced by Rivet rather than by the
reviewer agreeing to stop.

## What already exists, and what M8 actually adds

More of M8 is already in the codebase than is obvious, because M1 wrote the state machine for the
whole product rather than for the milestone in front of it.

Already present:

- `reviewing` and `revising` are real values in `JOB_STATUSES` and in the `job_status` pgEnum. No
  enum migration is needed, which is the expensive kind.
- `ALLOWED_TRANSITIONS` already has `testing -> reviewing`, `reviewing -> revising`,
  `reviewing -> finalizing` and `revising -> testing`. The loop the PRD draws is already a legal
  walk through the guard table.
- `BOUNDARY_CHECKPOINT_PHASES` already lists both `reviewing` and `revising`, so a completed review
  or revision already captures a workspace checkpoint once those phases exist.
- `planning-phase.ts` is a working, tested example of exactly the thing the reviewer needs to be: a
  read-only model session whose only durable output is a Zod-validated structured value submitted
  through a worker-side capability, with a hard failure when the session ends without submitting.
- `PiCodingAgent` already asserts, after session construction, that `getActiveToolNames()` equals
  the role's expected set. Adding a third role extends a mechanism rather than inventing one.
- Budgets are already cumulative on the job row and already seeded from the claimed row, so a
  reviewer session and a revision session spend from the same ceilings without any new machinery.

What M8 actually adds:

1. A third coding-agent role, `reviewer`, with four capabilities: `list_files`, `read`,
   `search_text`, `submit_review`.
2. A structured review report contract, its artifact type, its events, and two failure categories.
3. A `reviewing` phase body that runs the reviewer session and persists the verdict.
4. A `revising` phase, which does not exist at all today: it is absent from `PHASE_TEMPLATE`.
5. A loop in the phase runner, because `runPipeline` walks a `Phase[]` exactly once.
6. Durable loop accounting on the job row, so a crash mid-loop cannot hand the replacement worker a
   fresh review budget.
7. A per-run `reviewMode` of `independent` or `none`, so a single job can skip review without a
   second pipeline existing.

## The seven decisions this plan rests on

### 1. The loop is a runner concept, not something a phase hides

`runPipeline` is a `for...of` over a frozen list. The review loop needs
`reviewing -> revising -> testing -> reviewing`, up to a bound, decided at runtime by a model's
verdict. Three ways to express that, and the choice matters more than it looks.

Hiding the loop inside one long `reviewing` body would be the smallest diff and the worst outcome:
the job would sit in status `reviewing` while an implementer session wrote code, `revising` would
remain a status nothing ever enters, and the timeline would be lying about what the job was doing.
Pre-expanding the array with N skipped copies of the loop gives `resume-plan.ts` duplicate statuses
to `findIndex` over, which turns an unambiguous cursor into a guess.

So the runner grows one concept. A phase body may return a directive:

```ts
export type PhaseDirective = { kind: "cycle"; phases: readonly Phase[] } | undefined;
```

and the runner walks a mutable queue rather than a fixed list:

```text
queue: [... testing, reviewing, finalizing]

reviewing returns { kind: "cycle", phases: [revising, testing, reviewing] }
  => queue becomes [revising, testing, reviewing, finalizing]

reviewing returns undefined
  => queue continues to finalizing
```

The runner does not know what a review is. It knows that a phase may ask for a list of phases to be
run before the rest of the queue, and it enforces one structural rule: the phases a directive names
must already be phases this pipeline knows about, so a directive cannot conjure a body the worker
was not configured with. Everything else about the loop, including its bound, is decided by the
reviewing phase before it returns a directive at all. The runner keeps its existing properties: it
imports nothing, reads no environment, and still runs a full simulated pipeline in well under a
millisecond at `speed: 0`.

`finalPhaseStatus()` stays correct because `finalizing` remains the last element of the template and
a directive only ever inserts phases ahead of the remaining queue.

### 2. Read-only is a capability boundary, and the reviewer gets exactly four tools

The reviewer's tool set is the planner's with `submit_plan` swapped for `submit_review`:
`list_files`, `read`, `search_text`, `submit_review`. No shell, and the absence is the point. A
shell can write, so handing the reviewer one would turn "read-only" from a property the adapter
asserts into a sentence in a prompt, and it would let the session dirty the very diff it is judging.
Validation ran before review, so a reviewer-authored edit would reach `finalizing` having been
validated by nothing.

The reviewer does not run tests. It does not need to: M7 already ran targeted tests, the full suite,
typecheck and lint, and the reviewer receives the parsed report. Re-running the suite inside the
review session would buy a second opinion on a deterministic fact and pay for it with another
several minutes of container time.

`submit_review` is the reviewer's one worker-side capability, and it follows `submit_plan` exactly:
it validates a structured value, hands it to the phase, and can read nothing, write nothing and
execute nothing. As with planning, a JSON-shaped assistant message is not a review. Only a
successful `submit_review` call is.

### 3. The reviewer sees the issue, the diff, the tests it changed, and the validation report

PRD §12.4 lists what the reviewer receives: original issue, final diff, relevant files, validation
results, implementation summary. All five already exist as durable rows by the time `reviewing`
starts, which means the reviewer's context is assembled from Postgres and the sandbox rather than
from process memory. That is not a stylistic preference. A reclaimed job's `reviewing` phase runs in
a different process on a different host from the `implementing` phase that produced the diff, so
anything held in memory is unavailable by construction.

The context is built from:

- `ctx.job.title` and `ctx.job.description` - the issue, as the task.
- The latest `diff` artifact and `diff_stat` artifact - what changed and how much.
- The latest `validation_report` artifact - every check, its outcome, and named new/pre-existing
  failures.
- The latest `implementation_summary` artifact - what the implementer says it did.
- The latest `implementation_plan` artifact - what it said it would do, which is what makes
  "incomplete implementation" a checkable claim rather than a vibe.
- On a second or later loop, the previous `review_report` - so the reviewer can see whether its own
  blocking findings were addressed rather than re-deriving them.

"Review changed tests" from the M8 checklist is handled by giving the reviewer the diff plus
`list_files`/`read`/`search_text`: the changed test files are in the diff, and the reviewer can read
them in full. No separate mechanism.

### 4. A blocking finding after the last loop fails the job

Validation is green and the independent reviewer still says the patch is wrong. Completing the job
anyway would make review decorative, and M9 would open a pull request that Rivet's own reviewer
rejected. So the exhausted loop is terminal: `reviewer_rejection`, a category PRD §23 already names.

This is a real trade. A reviewer false positive now costs a whole job, and PRD §21 lists reviewer
false positives as a known failure mode. Two things keep it honest: the review report is a durable
artifact on a failed job, so a rejection is always readable and always attributable to specific
findings rather than to a mood, and `reviewMode: "none"` remains available for a run where review is
not wanted.

A session that ends without calling `submit_review` is a different failure: `review_not_produced`,
terminal, mirroring `plan_not_produced`. Treating a missing verdict as an approval would be the one
bug in this milestone that nobody would ever notice.

### 5. Review mode is a property of the job, not a deployment switch

Review is part of the workflow, so turning it off is a decision about one run rather than about a
worker. `jobs` gains `review_mode text not null default 'independent'`, validated against
`z.enum(["independent", "none"])` in contracts and settable at creation.

`none` is one branch inside the existing pipeline: `buildPipeline` gives `reviewing` no body when
the job asks for it, so the phase falls back to its existing sleep and never returns a directive.
There is no second pipeline, no parallel code path, and no arm-selection logic anywhere. The mode is
readable on the job row and on the timeline, so a run that skipped review says so rather than
looking like a run whose reviewer had nothing to say.

`RIVET_REVIEW_MODE` in the worker configuration sets the default a job is created with. It is not a
kill switch consulted at run time: a job that recorded `independent` reviews, whichever worker picks
it up, which is the same property `max_cost_usd` has and for the same reason.

### 6. Loop accounting is durable, fenced, and belongs to the job

`AGENTS.md` states the invariant that budgets are the job's rather than the attempt's, because a
crash must never hand a replacement worker a fresh budget. The review loop is a budget. A worker
killed during the second revision must not come back and get two more loops.

So the loop bound and the loop counter are both columns, alongside the ceilings that already live
there:

- `max_review_loops integer not null default 2` - PRD §12.4's recommendation, the job's own bound.
- `review_loops integer not null default 0` - how many revisions this job has already spent.
- `review_decision text` and `review_blocking_count integer` - the last verdict, for the detail page
  and for anything later that wants to count outcomes without replaying the event log.

They are written by a new small writer, `recordReview()`, fenced on `lease_owner` and taking the
same `TransitionPatch` shape that `recordProvisioning` and `recordAgentUsage` take, so it cannot
touch `status`. That makes six `.update(jobs)` sites in `packages/`, and `AGENTS.md`'s enumeration
of the five must be updated in the same change rather than left to rot. It belongs here for the same
reason agent usage does: the fact becomes true when the reviewer answers, not when the job later
changes phase.

### 7. Recovery gets one new resume phase, and one new transition edge

`revising` becomes a phase that can be checkpointed, so `checkpoint.resume_phase` can now say
`revising`. Two things follow, and both are small edits that are easy to miss:

- `ALLOWED_TRANSITIONS.provisioning` must gain `revising`. Its current comment explicitly says
  `revising` is absent because no checkpoint kind resumes there. That sentence stops being true in
  this milestone and must be rewritten rather than deleted.
- `planResume()` maps a resume phase onto a pipeline suffix with `findIndex`, and `revising` is not
  in the base template. Resuming at `revising` must produce
  `[provisioning, revising, testing, reviewing, ...tail]`, which the plan builds explicitly rather
  than by index arithmetic. Resuming at `reviewing` keeps working unchanged, and the durable
  `review_loops` column is what stops a resumed `reviewing` from restarting the loop budget.

`ALLOWED_TRANSITIONS.reviewing` also needs `budget_exceeded`. It is absent today because reviewing
was a sleep; as of M8 it is a model session spending from the same cumulative ceilings, and without
the edge a reviewer that crosses a ceiling cannot record what stopped it - the transition is
refused, the failure escapes the processor, and the message is redelivered to breach again. That is
exactly the reasoning already written into the `planning` row when M6 made planning a real session.

## Migration

One migration, no enum change:

```sql
alter table jobs add column review_mode text not null default 'independent';
alter table jobs add column max_review_loops integer not null default 2;
alter table jobs add column review_loops integer not null default 0;
alter table jobs add column review_decision text;
alter table jobs add column review_blocking_count integer;
```

Generated with `pnpm db:generate`, the SQL committed under `packages/database/drizzle/`, applied
with `pnpm db:migrate`. Every column is nullable or defaulted, so existing rows are valid and the
migration is backwards compatible with a worker that predates it.

## The review report contract

Wire and TypeScript surface is camelCase, matching every other contract in the repo. PRD §6.8's
snake_case sketch is illustrative rather than normative, and mixing conventions in one payload is
worse than either convention.

```ts
export const reviewIssueSchema = z.object({
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().min(1).max(4000),
  /** Repository-relative paths this finding is about. May be empty. */
  paths: z.array(z.string().trim().min(1)).max(20).default([]),
  category: z.enum([
    "correctness",
    "incomplete",
    "concurrency",
    "security",
    "edge_case",
    "unnecessary_change",
    "weak_test",
    "compatibility",
  ]),
});

export const reviewReportSchema = z.object({
  decision: z.enum(["approve", "revise"]),
  blockingIssues: z.array(reviewIssueSchema).max(20),
  nonBlockingIssues: z.array(reviewIssueSchema).max(20),
  confidence: z.number().min(0).max(1),
  summary: z.string().trim().min(1).max(4000),
});
```

The `category` enum is PRD §6.8's "reviewer should look for" list turned into a closed vocabulary,
which is what lets the detail page group findings and lets anything later count them by kind instead
of grepping prose.

One cross-field rule, enforced in the schema rather than in the phase: `decision: "revise"` requires
at least one blocking issue, and `decision: "approve"` requires none. A verdict that says revise and
names nothing to fix cannot be acted on, and one that approves while listing blockers is
self-contradictory. Rejecting both at the tool boundary means the model gets a tool error it can
correct on the next turn, which is strictly better than the phase discovering the contradiction
after the session has ended.

The vocabulary additions:

- Artifact type: `review_report`.
- Events: `review.recorded` (a verdict was persisted; carries decision, loop number, counts,
  confidence), `review.revision_requested` (the loop is going around again; carries loop number and
  blocking count), `review.limit_reached` (the last loop ended with blocking findings),
  `review.skipped` (the job asked for `reviewMode: "none"`).
- Failure categories: `review_not_produced` (terminal), `reviewer_rejection` (terminal).

`run.summarized` gains the review decision and loop count, because the closing line of a run should
say whether a second agent looked at it.

## Stage 0 - fixtures and the acceptance contract

A review milestone needs something to find. The M7 fixture repository is not enough on its own,
because a correct patch produces an approval on the first loop and the loop never runs.

- **A scripted reviewer.** `RIVET_AGENT=scripted` gains reviewer-role support in
  `packages/agent/src/fake-agent.ts`, so integration tests can script "revise once, then approve",
  "revise every time", and "end without submitting". This is what makes the loop, the bound and both
  failure categories testable with no model key and no Docker.
- **A fixture task with a plantable flaw.** In `rivet-fixture-node`, a task whose obvious
  implementation passes the test suite while missing an edge case the issue text names. The point is
  a job where deterministic validation is green and the correct answer is still "revise".
- **The acceptance contract.** Before writing phase code, write down what a passing M8 looks like:
  the event sequence for an approved run, for a one-loop revision, for an exhausted loop, and for
  `reviewMode: "none"`. Those four sequences are the assertions the integration tests make.

## Stage 1 - contracts

`packages/contracts`: the schemas above, `parseReviewReport`/`serializeReviewReport` mirroring the
implementation-plan pair, the artifact type, the four events, the two failure categories,
`reviewModeSchema`, and the optional `reviewMode` and `maxReviewLoops` fields on `createJobSchema`
with their defaults. Unit tests for the cross-field rule in both directions, for the bounds, and for
a round trip.

Nothing else may be touched in this stage. It is the one stage every later stage depends on.

## Stage 2 - database

The five columns, the generated migration, and the Drizzle schema edit. `JobDetail` grows the five
fields so the web surface can read them without a second query.

## Stage 3 - the port

`packages/core/src/agent/coding-agent.ts`:

- `CODING_AGENT_ROLES` gains `reviewer`.
- `ReviewerAgentToolbox` with `role: "reviewer"`, `listFiles`, `readFile`, `searchText`,
  `submitReview`, added to the `AgentToolbox` union.
- `ReviewNotProducedError` and `ReviewerRejectionError` in `../jobs/failure`, classified terminal in
  `classify()` alongside `PlanNotProducedError`.

Core still imports no harness. This stage is types plus two error classes.

## Stage 4 - the adapter

`packages/agent`:

- `RIVET_REVIEWER_TOOL_NAMES`, sorted, and the role switch in the expected-tool-names helper.
- `createSubmitReviewTool`, modelled on `createSubmitPlanTool`, whose description states plainly
  that this must be the reviewer's final action.
- The reviewer branch in `PiCodingAgent.start`, with the same post-construction
  `getActiveToolNames()` assertion. A test asserts the reviewer's active tools are exactly the four,
  which is the guarantee that a harness upgrade cannot quietly hand the reviewer a shell.
- Reviewer support in the scripted fake from Stage 0.

## Stage 5 - the runner learns to cycle

`run-pipeline.ts`: `Phase.run` returns `Promise<PhaseDirective>`, the walk becomes a queue, and a
directive naming a phase the pipeline does not contain throws. Existing phase bodies return
`undefined` and need no edits beyond their return type.

Unit tests: a directive inserts ahead of the remaining queue; a phase returning `undefined` behaves
exactly as before; a directive naming an unknown phase throws; cancellation mid-loop still throws
the signal's reason unchanged; the simulated pipeline still completes in well under a millisecond at
`speed: 0`.

## Stage 6 - the `reviewing` phase

`packages/core/src/pipeline/reviewing-phase.ts`, structured like `planning-phase.ts`:

1. Read the durable inputs: diff, diff stat, validation report, implementation summary, plan, and
   the previous review report when the loop counter is above zero. `PhaseContext` gains
   `readLatestReviewReport()` alongside its existing readers.
2. Build the reviewer toolbox: `listFiles` and `searchText` over fixed Git argv exactly as the
   planner does, `readFile` through the sandbox with the same byte cap, `submitReview` validating
   through the Stage 1 schema and refusing a second submission.
3. Run the session through `runAgentSession`, which already handles budget enforcement between
   turns, usage persistence and provider failure classification.
4. No submission: throw `ReviewNotProducedError`.
5. Persist the `review_report` artifact and write `review.recorded`.
6. Decide, deterministically:
   - `approve` -> call `recordReview()` with the final decision and counts, return `undefined`.
   - `revise` and `review_loops < max_review_loops` -> increment the counter through
     `recordReview()`, write `review.revision_requested`, return
     `{ kind: "cycle", phases: [revising, testing, reviewing] }`.
   - `revise` and `review_loops >= max_review_loops` -> write `review.limit_reached` and throw
     `ReviewerRejectionError`.

Step 6 is the whole of `maxReviewLoops` enforcement. The model never sees the counter and cannot
spend it.

## Stage 7 - the `revising` phase

`revising-phase.ts` is an implementer session with a different brief, so it reuses
`implementing-phase.ts`'s session plumbing rather than copying it: same role, same toolbox, same
turn checkpoints, same `recovery: "checkpoint"`. What differs is the context, which adds the
blocking findings, the non-blocking findings, and an instruction that its job is to address the
blocking findings without re-litigating the design the plan already settled.

`PHASE_TEMPLATE` does not gain a `revising` entry: `revising` only ever enters the queue through a
directive. It does need to be a phase the pipeline _knows about_, which is what the runner's
structural check validates against, so `buildPipeline` returns the template plus a small map of
directive-reachable phases.

Two ways `reviewing` stays a sleep and no directive is ever returned: `RIVET_AGENT=off`, which keeps
the infrastructure-free path working exactly as it does now, and `reviewMode: "none"` on the job,
which writes `review.skipped` so the timeline says which one it was.

## Stage 8 - orchestration, recovery, and configuration

- `recordReview()` in `packages/core/src/jobs/`, lease-fenced, `status`-proof by type.
- `ALLOWED_TRANSITIONS`: `provisioning` gains `revising`; `reviewing` gains `budget_exceeded`; both
  comments rewritten to say why.
- `planResume()` handles `revising`, with a unit test for the produced suffix and a test that a
  resumed job does not reset `review_loops`.
- `apps/worker/src/config.ts`: `RIVET_REVIEW_MODE` (`independent` by default) and
  `RIVET_MAX_REVIEW_LOOPS` (2 by default, validated 0 through 5), both of which are the defaults a
  job is created with rather than run-time switches.

## Stage 9 - the web surface

The detail page gains a review panel: decision, confidence, loop count, and the two findings lists
rendered by category. The four new events get timeline presentations, and
`review.revision_requested` is the one that makes a looping timeline readable, since without it the
second `testing` block looks like a duplicate. `StatusBadge` already has colors for `reviewing` and
`revising`, since the `Record<JobStatus, ...>` has always been exhaustive.

No new endpoint: the review report is an artifact and `/api/jobs/:id/artifacts` already lists and
serves artifacts by id.

## Stage 10 - verification

- `pnpm test`: contracts, runner cycles, resume suffix, phase decision logic, the tool-name
  assertion. No database, no Redis, no Docker.
- `pnpm test:integration`: the four acceptance sequences from Stage 0 against a scripted reviewer -
  approve on the first loop, revise once then approve, revise until the bound and fail
  `reviewer_rejection`, and `reviewMode: "none"` reaching `finalizing` with `review.skipped` - plus
  `review_not_produced`, plus a crash during `revising` that resumes with the loop counter intact.
- `pnpm test:sandbox`: a real reviewer session against the fixture, asserting the active tool names
  and that the workspace diff is byte-identical before and after the review session. That second
  assertion is the read-only claim, measured rather than asserted.
- `pnpm demo:job` on the Stage 0 fixture, unchanged in name because review is the default path: one
  real job where the first patch is revised once and then approved. That is the M8 demo. The live
  model is nondeterministic, so the deterministic integration run B is the authoritative proof of
  the revision loop; the recorded demo approved its first patch.

## Definition of done

The default workflow is implementation, validation, independent review, revision, revalidation,
re-review, finalization, and every step of it is a durable row. A job whose implementation stays
wrong through the bound fails `reviewer_rejection` with a readable report. A worker killed during
`revising` is replaced by one that resumes with the same loop budget it had. A job created with
`reviewMode: "none"` runs the M7 workflow and says on its timeline that it did.

## Risks and deliberate limits

- **Reviewer false positives now cost jobs.** Mitigated by durable reports and by per-run
  `reviewMode`. Whether it happens often enough to matter is an M10 measurement.
- **The loop multiplies cost.** Two loops is three validation runs and up to five model sessions on
  one job. The cumulative job budgets already bound this, and `budget_exceeded` is a legal outcome
  from every phase in the loop.
- **The reviewer cannot run anything.** A finding that would need execution to confirm is reported
  as a finding rather than proven. That is the price of the capability boundary, and it is the right
  price.
- **No cross-loop memory beyond the previous report.** Each reviewer session is fresh, by design -
  independence is the point - so the previous verdict is context rather than conversation.
- **No comparison harness here.** Review versus no review is an optional M10 experiment; M8 leaves
  it exactly one field of surface area (`reviewMode`) and no benchmark code.
- **M9 inherits an unanswered question.** `finalizing` is still `recovery: "replay"`. When the
  branch, commit and push land there, that word has to change, and an approved review is what will
  be gating them.
