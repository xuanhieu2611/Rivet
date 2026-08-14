# Milestone 6: Planning, persistence, and recovery

**Status: planned.**

Milestone 5 proved that Rivet can take one coding job from a repository URL to a validated patch. It
also left the exact recovery boundary visible: Postgres can reclaim a job after a worker dies, but
the replacement worker starts the pipeline at `provisioning`, creates an empty sandbox, and repeats
every phase. The job survives. The coding attempt does not.

Milestone 6 makes the attempt durable without pretending a model process can be snapshotted. Rivet
will persist a structured implementation plan, capture a lossless workspace patch after every safe
boundary, and resume deterministic workflow state in a newly provisioned sandbox. A replacement Pi
session receives the restored workspace and a bounded recovery context. Pi's private process memory
and raw session file are not part of the checkpoint format.

The target recovery path is:

```text
worker A dies during implementing
  -> Postgres lease expires
  -> sweeper advances the dispatch generation and re-enqueues
  -> worker B claims the new generation
  -> worker B provisions a fresh sandbox at the original base commit
  -> worker B applies and verifies the latest lossless workspace patch
  -> a fresh Pi session receives the persisted plan and recovery summary
  -> the pipeline continues from implementing
  -> validation and finalization run once the resumed attempt succeeds
```

This is workflow resumption, not hidden-reasoning serialization.

---

## What already exists, and what M6 actually adds

Several M6 checklist items are partly true before this milestone starts:

- `jobs` already persists the authoritative lifecycle, lease, attempt count, limits, sandbox
  metadata, and cumulative token and cost totals.
- `job_events`, `job_commands`, and `job_artifacts` already persist observable activity, bounded
  transcripts, the final diff, validation result, and implementation summary.
- the sweeper already detects an expired lease, returns the row to `queued`, and asks Redis for
  another delivery.
- the reaper already destroys containers left behind by `kill -9`.
- phase consumers already read the baseline, session summary, and validation result back from
  Postgres instead of relying on a previous phase's memory.

M6 must not build second versions of those systems. Its additions are narrower:

1. a real planning phase and a structured plan artifact
2. a durable workflow cursor and lossless workspace snapshot
3. a queue generation that lets a reclaimed attempt run without waiting for the dead BullMQ message
   to become stalled
4. deterministic sandbox rehydration at the original base commit
5. phase selection from the last safe checkpoint
6. budgets and event readers that remain correct across several Pi sessions
7. a recovery contract for future non-repeatable external effects

---

## The nine decisions this plan rests on

### 1. Checkpoint completed Pi turns and completed phases

A phase-only checkpoint would make `planning` durable but would throw away all edits when a worker
dies halfway through `implementing`. M6 instead captures a full workspace patch after every
`agent.turn_completed` event and after every completed non-terminal phase. The transition to
`completed` is the durable acknowledgement for `finalizing`, so it does not need a checkpoint whose
only instruction would be to finish an already finished pipeline.

The patch is always relative to the job's immutable `base_commit_sha`, not relative to the previous
checkpoint. Each checkpoint is independently restorable. That costs more storage than a delta chain,
but it prevents one missing or corrupt middle row from invalidating everything after it.

### 2. Resume Rivet state, not a Pi JSONL session

Pi 0.84.1 supports file-backed sessions and resumption. Rivet will not use that as its durability
boundary in M6. A raw Pi session is adapter-owned, version-sensitive, and may contain context Rivet
does not need to claim as application state.

Recovery starts a fresh Pi implementation session. Its first prompt contains the original task,
persisted implementation plan, baseline, restored diff summary, previous session outcome, and an
instruction to inspect and test the restored work before continuing. The context is assembled from
Rivet contracts and records, so a Pi upgrade does not become a checkpoint migration.

### 3. Planning is a separate, read-only Pi role

`planning` becomes a real phase before implementation. It starts a fresh Pi session with a
role-specific tool set:

```text
list_files
read
search_text
submit_plan
```

`list_files` is backed by fixed `git ls-files` arguments and `search_text` by fixed `git grep`
arguments. Neither accepts a shell program. The planner gets no `bash`, `write`, or `edit`, which
makes read-only a capability boundary rather than a sentence in a prompt.

`submit_plan` is the one intentional worker-side tool. Its only capability is to submit a Zod-
validated `ImplementationPlan` value to the planning phase. It cannot read or write the worker
filesystem, execute a command, or access a credential. The Pi adapter asserts the exact active tool
set for each role:

```text
planner:     list_files, read, search_text, submit_plan
implementer: bash, edit, read, write
```

The second model session costs tokens, but it makes the `planning` status truthful and gives
recovery a durable plan that is independent of the implementation conversation.

### 4. Checkpoint payloads live in PostgreSQL for M6

M6 adds no S3, R2, or MinIO dependency. A compressed, lossless binary Git patch lives in Postgres
beside its checkpoint metadata. The writer has a required `RIVET_CHECKPOINT_MAX_BYTES` limit,
defaulting to 4 MiB, plus `RIVET_CHECKPOINT_TIMEOUT_MS`, defaulting to 30 seconds. It records both
compressed and original sizes and rejects a patch that cannot be stored whole. Checkpoint content is
never truncated.

This keeps `pnpm build` and `pnpm test` free of infrastructure, keeps integration CI at Postgres and
Redis, and avoids introducing a fourth local service for a fixture patch measured in kilobytes. The
checkpoint module owns payload reads and writes so object storage can replace the body later without
changing phase code or the recovery planner.

### 5. A dispatch generation replaces one fixed BullMQ message identity

Today the BullMQ message id is the job UUID. That makes ordinary enqueueing idempotent, but a dead
worker leaves that id in `active`, so a sweeper cannot add the recovered delivery until BullMQ's
stalled-job detector releases it.

M6 adds `jobs.dispatch_generation`, beginning at zero. A delivery is identified by:

```text
<job UUID>.<dispatch generation>
```

BullMQ custom ids must not contain a colon. A reclaim atomically increments the generation when it
moves the job to `queued`, then enqueues that generation. The message carries both `jobId` and
`dispatchGeneration`, and `claimJob` rejects a stale generation. The old active message may remain
in Redis until BullMQ cleans it up, but it can never reclaim or write the Postgres row.

Initial API retries remain idempotent because they request the same generation. A new generation is
created only by the durable reclaim transition, not by an arbitrary enqueue caller.

### 6. Budgets are cumulative across attempts

A crash does not grant another hour or another model budget. M6 persists total model calls, tool
calls, and turns alongside the token and cost totals that M4 already keeps. Planning and
implementation spend from the same job ceilings.

The first claim also establishes an immutable `deadline_at` from the database clock. Later claims
receive only the remaining wall-clock budget. Recovery downtime counts against the job deadline,
which prevents an unavailable worker fleet from keeping a supposedly one-hour job alive for days.
Session timeout remains per Pi session because it answers a different question: whether this one
model session stopped making progress.

### 7. M6 defines the external-effect protocol without building the M9 ledger

There is no GitHub branch, commit, push, or pull request side effect yet. Building an unused generic
receipt table would guess at M9's provider contract. M6 instead makes the recovery rule for
Rivet-owned actions explicit:

1. every future external action has a deterministic operation key
2. before repeating an uncertain action, reconcile with the external provider by that key
3. use the provider's idempotency key when it has one
4. persist the provider reference before marking the workflow phase complete
5. never treat a local timeout as proof that the provider did nothing

The phase recovery metadata introduced in M6 distinguishes replayable sandbox work from a future
`reconcile_external` phase. M9 will add the receipt table when a real GitHub action can define its
request fingerprint and reconciliation query.

This protocol cannot make arbitrary commands chosen by repository code exactly-once. The sandbox
still has network access, so a test or model-selected shell command may contact an external service.
M6 guarantees orchestration state and Rivet-owned effects. Restricting or brokering arbitrary egress
is a separate sandbox-hardening problem.

### 8. The orchestration stack stays unchanged

M6 remains Node 24, TypeScript 5.9, PostgreSQL through Drizzle, Redis through BullMQ 6, Docker, Pi
0.84.1, Next.js 16, Vitest, and Postgres-backed SSE. It adds no Temporal, Kubernetes, vector
database, or second workflow engine.

The state machine, checkpoints, and leases are the product being demonstrated. Moving them into a
workflow service would hide the exact engineering M6 exists to exercise and would create a data
authority question the current design does not have.

### 9. The plan is tracked separately from the PRD

This file is the implementation plan. `PRD.md` remains product intent and its M6 checklist remains
unchecked until the code lands and the recovery demo passes.

---

## Checkpoint contract

A checkpoint records reproducible workflow state, not a copy of the whole job row.

```text
job_checkpoints
  id                       bigserial primary key
  job_id                   uuid not null references jobs on delete cascade
  sequence                 integer not null
  attempt_count            integer not null
  kind                     text not null
  completed_phase          text
  resume_phase             text not null
  agent_turn               integer
  base_commit_sha          text not null
  sandbox_id               text not null
  env_fingerprint          jsonb not null
  state_json               jsonb not null
  patch_format             text not null
  patch_compression        text not null
  patch_sha256             text not null
  patch_byte_size          integer not null
  patch_compressed_bytes   integer not null
  patch_payload            bytea not null
  created_at               timestamptz not null default now()

  unique (job_id, sequence)
  index  (job_id, sequence desc)
```

M6 declares two checkpoint kinds:

- `phase_boundary`: the named phase completed, so recovery starts at `resume_phase`
- `agent_turn`: a Pi turn completed during `implementing`, so recovery restores the patch and starts
  a fresh implementation session

`state_json` is Zod-validated and versioned:

```ts
type CheckpointStateV1 = {
  version: 1;
  planArtifactId?: number;
  baselineEventId?: number;
  validationEventId?: number;
};
```

The checkpoint's sandbox id and environment fingerprint preserve where the snapshot came from even
after recovery overwrites the current values on `jobs`. The references in `state_json` identify
durable facts. They do not copy plan text, validation output, usage totals, lease state, or mutable
job status into JSON. Patch format, compression, checksum, sizes, and resume phase stay in their
typed columns rather than being duplicated in JSON. Those values keep one authoritative
representation.

The workspace payload is produced through a temporary Git index outside the repository:

```text
GIT_INDEX_FILE=<temporary index> git read-tree HEAD
GIT_INDEX_FILE=<temporary index> git add -A
GIT_INDEX_FILE=<temporary index> git diff --cached --binary --full-index --no-renames --no-ext-diff --no-textconv HEAD
```

The temporary index is required so new files are included without changing the repository's real
staging state. Running `git add -A` against the real index after every turn would make the next
session's ordinary `git diff` appear empty and would overwrite any staging choices the model made.
`--binary` and `--full-index` make binary edits, modes, deletions, and new files recoverable.
Renames are represented deterministically as a delete plus an addition. External diff drivers and
text conversion are disabled so repository configuration cannot change the checkpoint format or
execute another program during capture. The patch is gzip-compressed and SHA-256 is computed over
the uncompressed bytes. The writer rejects truncated command output, an absent base commit, an
unsupported checkpoint version, or a payload above the configured limit. The temporary index is
removed on every exit.

`recordCheckpoint()` is the only writer. It locks the job row, verifies `lease_owner`, allocates the
next per-job sequence, inserts the checkpoint, and appends `checkpoint.created` in one transaction.
A stale phase can compute a patch, but it cannot make that patch authoritative after losing its
lease.

Checkpoint rows are append-only in M6. Full snapshots are intentionally bounded, and the fixture
keeps them small. Storage retention and content-addressed blob deduplication are deferred until real
run data shows that checkpoint volume warrants them.

---

## Resume selection and phase semantics

Every claim still enters `provisioning`. A recovered run must create and verify its execution
environment before it can truthfully display `implementing` or `testing`.

After claim, the processor reads the latest compatible checkpoint and constructs a `ResumePlan`:

```ts
type ResumePlan =
  | { kind: "fresh"; phases: readonly Phase[] }
  | {
      kind: "checkpoint";
      checkpoint: JobCheckpoint;
      restorePatch: Uint8Array;
      resumePhase: JobStatus;
      phases: readonly Phase[];
    };
```

A recovered phase list always starts with recovery provisioning, followed by the suffix beginning at
`resumePhase`. For example:

```text
checkpoint says resume implementing
  -> provisioning, implementing, testing, reviewing, finalizing

checkpoint says resume testing
  -> provisioning, testing, reviewing, finalizing
```

For every non-terminal phase, `resumePhase` is the next phase in the workflow. An `agent_turn`
checkpoint resumes `implementing`. `finalizing` has no standalone boundary checkpoint: the existing
lease-fenced transition from `finalizing` to `completed` is its acknowledgement. If a crash occurs
after a finalizing write but before that transition, finalizing is replayed and its durable readers
select the latest complete record. M9 must replace replay with external reconciliation before adding
GitHub actions there.

Recovery provisioning is not allowed to replace the later checkpoint with a new "resume analyzing"
checkpoint. It is hydration, not a replay of the original phase boundary.

The transition guard gains explicit recovery edges from `provisioning` to each resumable phase.
Those edges are used only after a lease-fenced `checkpoint.restored` record. The normal fresh
pipeline continues to walk `provisioning -> analyzing -> planning -> implementing` in order.

The latest checkpoint must satisfy all of these before it is used:

- supported state schema, patch format, and compression
- job id and original `base_commit_sha` match
- stored byte count and SHA-256 match the decompressed payload
- `resume_phase` is legal for the checkpoint kind
- cumulative job budget is not already exhausted

A checkpoint that fails integrity validation is a terminal `checkpoint_corrupt` failure. Rivet does
not silently discard acknowledged progress and restart from zero. A patch that cannot apply to the
original commit is `checkpoint_restore_failed`, with the failing command recorded. Both are explicit
because claiming recovery while quietly losing work is worse than failing loudly.

---

## Stage 0 - lock the acceptance contract

Before changing schema or pipeline code, add a short recovery scenario to the integration support
layer and record the expected event sequence. The fixture run must establish these facts:

1. planning submits and persists a valid structured plan
2. implementation completes at least one turn and creates a non-empty checkpoint
3. worker A is terminated without graceful cleanup
4. the lease expires and the reclaim advances the dispatch generation
5. worker B claims the new generation before BullMQ declares the old message stalled
6. worker B creates a new container at the same base commit
7. the restored diff matches the checkpoint checksum
8. completed analysis and planning are not rerun
9. a fresh implementation session sees the plan and restored-work context
10. validation completes and the job reaches `completed`

This becomes the milestone's north-star test. Individual stages add smaller tests, but none may
weaken this sequence to make their local implementation easier.

**Acceptance contract locked:** `apps/worker/tests/integration/support.ts` now owns the ordered
milestone trace, its event-key normalizer, and assertions for the ten non-event facts above.
`apps/worker/tests/integration/recovery-contract.int.test.ts` records the distinctions the eventual
fixture must preserve, including the two attempts, two dispatch generations, phase-boundary and
agent-turn checkpoints, and the single analysis and planning pass. The worker-crash test remains a
Vitest TODO until the schema and pipeline stages give it durable plan, checkpoint, restore, and
context records; it is a contract placeholder, not a weaker retry test.

## Stage 1 - contracts, schema, and migration

Add an `ImplementationPlan` contract to `@rivet/contracts` with exactly the six PRD sections:

```text
problemInterpretation
relevantComponents[]
reproductionStrategy[]
implementationApproach[]
validationPlan[]
riskAreas[]
```

Strings are trimmed and individually bounded. Arrays have non-zero minimums and conservative
maximums. The contract provides a canonical JSON serialization and a renderer for the web surface.

Add:

- `implementation_plan` to `ARTIFACT_TYPES`
- `plan.recorded`, `checkpoint.created`, `checkpoint.restored`, `checkpoint.rejected`, and
  `run.resumed` to `JOB_EVENT_TYPES`; retain `plan.deferred` so historical rows remain valid
- checkpoint ids, sequences, kinds, resume phases, attempts, turns, sandbox ids, patch sizes, and
  dispatch generations to `JobEventData` and its normalizer
- `plan_not_produced`, `checkpoint_corrupt`, `checkpoint_restore_failed`, and `checkpoint_too_large`
  failure categories
- the `job_checkpoints` table above
- `dispatch_generation`, `deadline_at`, `total_model_calls`, `total_tool_calls`, and `total_turns`
  on `jobs`

Generate and commit the Drizzle SQL. The status enum does not change. Checkpoint kinds, formats, and
failure categories remain Zod-validated text because they are growing vocabularies, not indexed
state machines.

## Stage 2 - generation-aware queue delivery and fencing

Change the queue port from an idempotency key of `jobId` to `(jobId, dispatchGeneration)`:

```ts
enqueueJobRun(jobId, dispatchGeneration, options?)
removeJobRun(jobId, dispatchGeneration)
```

Both the in-memory and BullMQ adapters use the encoded generation id. `JobRunsMessage` carries the
generation, and the processor hands it to `claimJob`. Claim succeeds only when both
`status = queued` and the durable generation match.

The expired-lease transition increments `dispatch_generation` in the same Postgres transaction that
clears the lease and writes `job.reclaimed`. The sweeper enqueues the returned generation only after
that transaction commits. A stale message from worker A eventually redelivers, fails the generation
precondition, and completes harmlessly.

Run one reconciliation pass when a worker starts, in addition to the BullMQ scheduler. The pass is
safe to run from every worker because expired-row selection, status compare-and-swap, and generation
claiming remain the correctness mechanisms. Production lease and sweep defaults remain conservative;
integration tests and `demo:recovery` use compressed real timings.

Generation-aware duplicate delivery makes write fencing more important, so this stage also audits
every phase write. Events, command rows, artifacts, usage, provisioning metadata, and checkpoints
must verify the active lease before committing. `transitionJob()` remains the only status writer,
and a lease-lost process still writes nothing after discovering the loss.

## Stage 3 - the checkpoint store

Add `packages/core/src/checkpoints/` and update the permitted core directory list in `AGENTS.md`.
The module contains:

- `recordCheckpoint()` as the only writer
- `getLatestCheckpoint()` and `getCheckpoint()`
- Zod parsing and version dispatch for `state_json`
- gzip compression and bounded decompression
- SHA-256 and byte-count verification
- conversion from a row into a restorable checkpoint
- pure helpers for phase-to-resume mapping

Add a checkpoint capability to `PhaseContext`. Phase code asks to capture a safe boundary; it never
inserts a row or compresses bytes itself. Internal Git snapshot commands are represented by the
`checkpoint.created` record rather than six extra timeline rows per Pi turn. Failures still record
the command and its bounded stderr before classification.

At a phase boundary, workspace capture happens first, then `phase.completed` and the checkpoint row
commit together. If Postgres fails, the phase is not acknowledged as safely complete and recovery
replays it. At an agent-turn boundary, the existing turn event may precede the checkpoint; a crash
in that narrow window falls back to the previous safe checkpoint, which is at-least-once progress
rather than a false acknowledgement.

## Stage 4 - make `planning` real

Replace `planningPhase()` and `plan.deferred` with the dedicated planner session.

The planner receives:

- original task title and description
- repository URL, branch, and resolved commit
- detected project and package-manager metadata
- bounded README and manifest context
- the baseline result and command
- progressive `list_files`, `read`, and `search_text` access

The phase accepts only a valid `submit_plan` call. An assistant message that merely looks like JSON
does not count, and a session that ends without submitting a plan fails with `plan_not_produced`.
Persist the canonical plan as an `implementation_plan` artifact and emit a concise `plan.recorded`
timeline entry. A structured plan must fit whole inside the artifact bound; the writer rejects it
instead of applying the ordinary head-and-tail truncation policy. The artifact remains ordinary
Postgres-backed artifact content, so the existing list and fetch API needs no second storage path.

Extend the coding-agent port with explicit roles and role-specific capabilities rather than making
the existing implementation toolbox partially optional. Extend the fake agent so unit and
integration tests can submit deterministic plans without a provider key.

The implementation context builder reads the latest valid plan artifact and includes it in every
fresh or recovered implementation session. Planning usage is persisted through the same cumulative
accounting path as implementation usage.

## Stage 5 - capture safe implementation progress

When `SessionAccounting` records `turn_completed`, ask the checkpoint capability for an `agent_turn`
snapshot. Record the cumulative turn number rather than the new session's local turn number, because
recovery may start several sessions for one job.

The snapshot algorithm is:

1. create a temporary index from `HEAD`
2. stage the workspace into that temporary index with `git add -A`
3. read a binary full-index patch from the temporary index against `HEAD`
4. remove the temporary index without touching the repository's real index
5. reject truncated or oversized output
6. compute patch stats for observability
7. gzip and checksum the exact bytes
8. write the lease-fenced checkpoint
9. emit `checkpoint.created` with metadata but no patch content

An empty patch is a valid checkpoint during analysis or planning. During implementation it records
that the completed turn made no durable workspace change, which can still be useful after a
read-only diagnostic turn. Identical patches are allowed in M6 and make the event history honest.

Checkpoint failure is not ignored. A run that cannot persist the progress it claims is recoverable
fails with an explicit checkpoint category rather than continuing under a false durability promise.

## Stage 6 - provision and restore a fresh sandbox

Refactor provisioning into composable steps without changing the `SandboxProvider` port:

```text
create container
clone repository
checkout exact original base commit
[recovery only] upload and apply checkpoint patch
install dependencies from the restored lockfile
verify HEAD and restored diff
record the new environment fingerprint
```

Patch application uses a temporary path outside the repository and a fixed argv equivalent to:

```text
git apply --binary /home/node/workspace/rivet-checkpoint.patch
```

Recovery restores file content, additions, deletions, modes, and binary changes, but deliberately
does not restore the previous session's staged-versus-unstaged distinction. Applying into the
working tree keeps the replacement session's ordinary `git diff` useful. The same temporary-index
snapshot algorithm verifies the restored workspace without mutating the real index.

Installing after patch application matters. An interrupted session may have changed a manifest or
lockfile, and installing the base commit first would reconstruct a filesystem the session never had.
The checkpoint does not include `node_modules`, build output excluded by `.gitignore`, or the Docker
container itself.

After application, regenerate the same binary diff and compare its SHA-256 with the checkpoint. Only
then emit `checkpoint.restored` and let the status move from `provisioning` to the requested resume
phase. The restore event carries both the checkpoint's original sandbox id and the replacement
sandbox id, so the recovery demo can prove that this was reconstruction rather than container reuse.
Destroy the container on every mismatch through the processor's existing `finally`.

**Provisioning restores, with one deliberate reordering:** `provisioningPhase()` is now composed of
named steps - `createSandbox`, `cloneRepository`, `resolveBaseCommit`, `restoreCheckpoint`,
`detectProject`, `installDependencies`, `recordEnvironment` - and the `SandboxProvider` port did not
change. The phase asks `PhaseContext.readLatestCheckpoint()` on every claim rather than being handed
a resume plan, for the same reason the baseline is read back rather than passed between phases;
Stage 7's recovery planner reads the same row to choose the phase suffix. `resolveBaseCommit` pins
the original commit with `git fetch --depth 1 origin <sha>` and `git checkout --detach FETCH_HEAD`
whenever the job or its checkpoint already names one, so a branch that moved between attempts cannot
silently change what "the base" means.

The checksum verification runs **immediately after `git apply` and before the dependency install**,
rather than after it as the step list above says. The check exists to prove restoration was
lossless, and a package manager that rewrites a lockfile changes the working tree for reasons that
have nothing to do with restoration - running it first would fail perfectly restored jobs with
`checkpoint_restore_failed`. The install still runs against the restored manifest and lockfile,
which is the property that ordering existed to protect. A failure at any restore step records
`checkpoint.rejected` with the failing argv and bounded stderr before the phase fails; a checkpoint
row that will not validate is read before the container is created, so a terminal checkpoint costs
no Docker work. `ALLOWED_TRANSITIONS` gains the recovery edges from `provisioning` to `planning`,
`implementing`, `testing`, `reviewing` and `finalizing`; Stage 7 is what starts using them.

## Stage 7 - resume the phase suffix with a fresh Pi session

Add a recovery planner in core that maps a checkpoint to a legal pipeline suffix. It is
deterministic application code, not an agent decision.

For an `agent_turn` checkpoint, `implementing` starts a new Pi session with a recovery block
containing:

- checkpoint sequence and prior attempt number
- persisted implementation plan
- baseline outcome and exact validation command
- changed-file and line totals from the restored patch
- last completed assistant message from the previous session, bounded
- cumulative remaining model, tool, cost, turn, and wall-clock budgets
- an instruction to inspect `git diff`, run the relevant tests, and continue rather than restart

Do not replay the entire event stream or command transcripts into the prompt. They remain available
for UI replay, while the recovery prompt stays small and deterministic.

Readers that currently choose "the latest event in the whole job" become session-aware where needed.
In particular, implementation summary selection must look after the latest `agent.session_started`;
a recovered session that says nothing must not accidentally inherit the previous session's closing
message as its own.

Phase-boundary recovery skips completed phases. `analyzing` is not rerun after its checkpoint, so
the baseline continues to mean "before Rivet edited anything." `planning` is not rerun after its
artifact and checkpoint. `testing` and `finalizing` continue to read their inputs from durable rows,
as they already do.

**The suffix is real, and so is the boundary that makes it useful.** `planResume()` in
`packages/core/src/pipeline/resume-plan.ts` maps a checkpoint onto `[provisioning, ...suffix]` and
refuses - rather than silently starting over - a cursor this pipeline cannot honour. The processor
reads the row after the claim and treats that read as **advisory**: `provisioning` performs the
authoritative read, applies the patch and is where a bad checkpoint becomes `checkpoint.rejected`
and a terminal failure, so a read that fails here falls back to the fresh walk and lets provisioning
say why the run stops. `run.resumed` is written once, after the environment has been rebuilt and the
patch verified, and before the resumed phase starts.

Stage 7 also adds the `phase_boundary` writer that Stage 3 specified and no earlier stage supplied;
without it the only durable cursor was `agent_turn` and every reclaim reran analysis and planning.
The processor captures one at each completed phase in `BOUNDARY_CHECKPOINT_PHASES`, before the
`phase.completed` event, so a crash between the two replays the phase rather than skipping it.
`provisioning` and `finalizing` are deliberately excluded: recovery provisioning writing a boundary
would replace a later cursor with "resume analyzing" and rerun the baseline over an edited tree, and
`finalizing`'s lease-fenced transition to `completed` is already its acknowledgement. A run with no
sandbox - `RIVET_SANDBOX=off` - has no workspace to snapshot and skips the capture entirely.

The implementation prompt gains its recovery block when the newest checkpoint at prompt-build time
is an `agent_turn` row, which can only have come from a previous attempt: this attempt's session has
not started, so it has produced no turn checkpoints of its own. `readSummary()` is now session-aware

- it stops at the newest `agent.session_started` - so a recovered session that says nothing cannot
  inherit the interrupted session's closing message, and the planner's messages stop being
  candidates for the implementation summary at the same time. Budgets in that block report
  cumulative turns and spend from the job row and wall-clock remaining from `started_at`, which
  `claimJob` coalesces across attempts; the model and tool ceilings are stated as the per-session
  ceilings they currently are, and Stage 8 makes them cumulative.

## Stage 8 - cumulative budgets and recovery-safe completion

Extend agent accounting so every planner and implementation event updates cumulative counters under
the active lease. A new session initializes from the job row rather than zero. A ceiling reached
before session creation fails immediately; a ceiling crossed on an event persists the totals before
transitioning to `budget_exceeded`.

Replace the per-claim full job timer with time remaining until `deadline_at`. The first claim sets
the deadline atomically from Postgres `now()`. A reclaimed job whose deadline passed while no worker
was available moves to `timed_out` without provisioning another container or starting another model
session.

Audit phases for at-least-once replay. Database-only outputs such as plans, summaries, and diff
artifacts may be attempted again if a crash lands before the boundary checkpoint, but their readers
must select the latest complete record and the timeline must show the attempt boundary. No phase may
perform an unclassified external action. Add recovery metadata to `Phase` now so M9 cannot add a
GitHub effect without choosing `reconcile_external` explicitly.

The recovery vocabulary is deliberately small: `replay`, `checkpoint`, and `reconcile_external`.
Every phase declares one. M6 uses the first two; the third exists so adding the first GitHub call in
M9 becomes a compile-time decision rather than an accidental replay policy.

## Stage 9 - web surface

The job detail page adds two small surfaces:

- an Implementation plan panel rendering the six structured sections from the latest
  `implementation_plan` artifact
- recovery timeline presentations for checkpoint creation, reclaim, restore, rejected checkpoint,
  and resumed execution

Checkpoint patch payloads are not exposed through the artifact API. The UI receives only checkpoint
metadata already present in events: sequence, kind, phase, turn, attempt, byte size, and patch
stats. There is no checkpoint download endpoint in M6.

The existing terminal `router.refresh()` is enough to load the final plan artifact. Checkpoint and
recovery events already travel through the Postgres SSE stream, so no new live transport or polling
loop is added.

## Stage 10 - recovery demo, verification, and documentation

Add a deterministic `pnpm demo:recovery` harness. It uses the public fixture, real Postgres, Redis,
and Docker, but a scripted planning and implementation agent so the demonstration tests recovery
rather than model sampling. The harness:

1. starts worker A with compressed lease timings
2. creates a job and waits for a non-empty implementation checkpoint
3. sends `SIGKILL` to worker A
4. starts worker B without the fault
5. waits for reclaim, restore, validation, and completion
6. asserts the container id changed, base commit did not, dispatch generation increased, and
   restored patch checksum matched
7. prints the recovery timeline and exits non-zero on any missing fact

The automated verification matrix is:

- **Unit, no infrastructure:** plan schema and bounds; role-specific tool assertions; checkpoint
  state parsing; gzip and checksum handling; decompression limits; phase suffix selection; stale
  generation rejection; cumulative budget math; session-aware summary selection.
- **Integration, Postgres + Redis:** lease-fenced sequence allocation; checkpoint/event atomicity;
  stale checkpoint writer rejection; generation-aware enqueue idempotency; immediate reclaim while
  the old BullMQ message is active; startup reconciliation; cumulative counters and deadline reuse.
- **Worker crash integration:** a child worker is killed after a turn checkpoint and a second child
  completes from the restored workflow cursor.
- **Sandbox, Postgres + Redis + Docker:** binary patch capture and application; new files, deletes,
  renames, modes, and binary files; restored-lockfile installation; checksum mismatch; oversized
  checkpoint cleanup; a new container restoring the exact staged diff.
- **Streaming, Postgres:** every new event type replays, reconnects, deduplicates, and drains at the
  terminal boundary like existing events.
- **Web unit tests:** structured plan rendering and recovery timeline copy.

Then run the ordinary gate from cold where useful:

```text
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm test:integration
pnpm test:sandbox
pnpm test:streaming
pnpm demo:recovery
```

Update `docs/architecture.md`, `README.md`, `.env.example`, and `AGENTS.md` only after the verified
implementation matches them. Architecture documentation must replace the current statement that
there are no checkpoints or resumable jobs, explain dispatch generations, and state plainly that a
fresh Pi session continues restored work.

---

## Definition of done

Milestone 6 is complete when a job can be killed during `implementing`, reclaimed by another worker,
restored into a different Docker container, and completed without rerunning acknowledged analysis or
planning.

The recovered job must leave durable evidence of:

- one structured Pi-generated implementation plan
- at least one lossless implementation-turn checkpoint
- the original and replacement attempts
- an incremented dispatch generation
- the original base commit
- a different sandbox id after recovery
- checksum-verified patch restoration
- a fresh Pi session receiving recovery context
- cumulative budgets that did not reset
- final validation and summary artifacts
- destruction of both the orphaned and replacement containers

The negative cases are part of the definition:

- a stale BullMQ message cannot claim a newer generation
- a stale worker cannot append phase state after losing its lease
- a corrupt, truncated, oversized, or non-applicable checkpoint cannot be advertised as restored
- a crash cannot reset the wall-clock, model-call, tool-call, token, or cost ceilings
- recovery cannot silently restart from zero after acknowledged workspace progress
- no raw Pi session file or undocumented model reasoning is stored as a Rivet checkpoint

The demonstration succeeds only if worker B resumes from the recorded checkpoint. A run that merely
starts another whole coding attempt and eventually reaches green does not satisfy M6.

## Risks and deliberate limits

- **Postgres growth from full workspace snapshots.** Every checkpoint is independently restorable,
  which duplicates bytes across turns. The payload cap makes growth bounded per row, and M6 measures
  actual volume before adding blob deduplication or object storage.
- **Checkpoint latency between turns.** `git diff --binary` over a very large workspace can be slow.
  It runs only after a completed turn, has its own timeout, and is visible in checkpoint duration
  metrics. M6 does not checkpoint after every file write.
- **A plan session adds cost.** Planning spends from the same durable job budget and is
  independently measurable. Later evaluation can compare explicit planning with no planning as PRD
  Experiment 2 proposes.
- **Fresh-session context is lossy by design.** The replacement model receives durable facts and a
  bounded summary, not every prior token. The restored code and tests are the authoritative state.
- **Git patches do not capture ignored build products or dependency directories.** Recovery rebuilds
  dependencies and asks the new session to rerun tests. M6 checkpoints source work, not a container
  filesystem image.
- **Wall-clock deadline includes downtime.** This prevents budget extension through repeated
  crashes, but a long worker outage can time out otherwise recoverable work. That is stated in the
  UI rather than hidden.
- **External effect receipts remain M9 work.** M6 supplies the recovery classification and protocol,
  but it cannot prove GitHub reconciliation before a GitHub adapter exists.
- **An in-flight model request is not exactly-once.** A provider may bill a request whose response
  disappears with `kill -9`, and OpenRouter supplies no operation reconciliation Rivet can query.
  Completed, reported usage remains cumulative, but M6 does not claim exact provider billing across
  an ambiguous network interruption.
- **Arbitrary sandbox commands are not exactly-once.** Rivet can restore repository state, but it
  cannot discover whether untrusted repository code called an external service before the worker
  died. The idempotency contract applies to Rivet-owned effects; network allowlisting and an egress
  proxy remain later hardening work.
- **Review remains simulated.** Recovery can resume past `testing`, but the `reviewing` phase stays
  a sleep until M8.
- **No object storage yet.** A checkpoint above the Postgres cap fails explicitly. S3-compatible
  payload storage remains the next step if real repository patches regularly hit that bound.
