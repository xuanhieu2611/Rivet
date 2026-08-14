# Milestone 5: First autonomous coding job

**Status: planned.**

Milestone 4 proved the wiring: a model runs on the worker, its four tools reach into the job's
container, and every turn it takes is on the timeline with a bill attached. What M4 deliberately did
not do is form an opinion about the result. The session ends, the job goes green, and nothing
anywhere has asked whether the repository is better than it was.

Milestone 5 is that opinion. It closes the loop PRD §31 draws:

```text
create job -> queue job -> start worker -> provision sandbox -> start Pi
  -> observe run -> persist state -> validate result -> complete job
```

The two new words in that line are **validate** and **persist**. Everything else already works.

---

## The four decisions this plan rests on

Each of these was a real fork, and the alternative is recorded so a later milestone can reverse it
knowingly rather than by accident.

**Artifacts live in Postgres, behind one writer.** A new append-only `job_artifacts` table holds
bounded text with a truncation flag, exactly as `job_commands` holds transcripts. PRD §8 asks for
S3-compatible object storage and PRD §10.8 gives `Artifact` a `storage_url`, and both are right for
the end state. They are wrong for M5, because a fourth local service would have to be absent from
CI's `verify` job, present in two of the other three, and credentialed in the worker, all to store a
diff that is usually under 20KB. `PhaseContext.artifact()` is the only surface a phase sees, so the
day object storage arrives it is an adapter behind that method rather than an edit to five phases.

**The baseline moves to `analyzing`, and `testing` becomes validation.** Today `baselinePhase` is
wired to `testing`, which sits _after_ `implementing` in `PHASE_TEMPLATE`. So the phase whose entire
premise is PRD §11 C - "establish whether the repository is already healthy **before** modifying
anything" - currently runs after the modification. It has been measuring the wrong thing since M2,
which nothing noticed because nothing yet read the result back. M5 wires the baseline body to
`analyzing` and gives `testing` a new body that re-runs the same suite and compares. The seven
statuses, the pgEnum, `ALLOWED_TRANSITIONS` and `StatusBadge` are all untouched, which is the point
of choosing this over adding a `baseline` status.

**Pi owns the debugging loop; Rivet checks the answer once.** PRD §31 M5 says "Start with one Pi
implementation session", and PRD §14 says not to duplicate the harness's context management. So
"failure observation" and "iterative debugging" are things the session does with `bash` inside its
own turns, and M5's job is to make that likely (tell the model the baseline, tell it the test
command, require it to run the suite) rather than to drive it from outside. `runPipeline` stays a
flat walk over a list. No outer repair loop, no use of `revising`, no per-job iteration counter. If
the deterministic check in `testing` disagrees with the model, the job fails and says why, which is
a more honest M5 than a retry loop that hides a bad session behind a second one.

**The diff is a diff, not a commit.** `git add -A` then `git diff --cached` against the depth-1
clone's HEAD, which is `base_commit_sha`. No branch, no commit, no git identity in the container. M9
owns git identity and push, and configuring `user.email` inside the sandbox now would be inventing
half of that milestone's interface with none of its consumers.

---

## Deviation from the brief, stated up front

The diff is captured at the **top of `testing`**, not in `finalizing`.

The mechanism is exactly as decided. The placement is not, and the reason is durability: a job that
fails during validation, or is cancelled between validation and finalization, still produced work,
and the evidence of what the model did is the single most valuable thing to keep from a run that
went wrong. Capturing it as the first act after the session means the artifact exists on every path
that reaches `testing` at all. `testing` also needs the changed-file list to say anything useful, so
capturing there costs no extra commands. `finalizing` then persists the summary and the outcome, and
does not touch the diff again.

---

## Stage 0 - the fixture repository

**Done:** https://github.com/xuanhieu2611/rivet-fixture-node

External work, and it blocks the definition of done, so it goes first.

A new public GitHub repository, `rivet-fixture-node`, containing:

- one small module with a seeded, trivial bug (an off-by-one or an inverted comparison, per PRD
  §32's difficulty progression - **not** a race condition)
- a test suite that fails on exactly that bug and passes when it is fixed
- `"test": "node --test"`, so there is no test framework to install
- a zero-dependency `package.json` and a matching `package-lock.json`, so `detectPackageManager`
  resolves `npm`, `npm ci` succeeds offline-ish and in about a second, and corepack never runs
- a `.gitignore`, because `git add -A` respects it and a fixture that stages `node_modules` would
  teach us the wrong lesson about diff bounds

Public so the sandbox needs no credential. It is also the first entry in M10's evaluation corpus,
which is the other reason to make it deliberately boring.

As built: `src/discount.js` implements a bulk-discount rule the README states as "10 items or more",
and `qualifiesForBulkDiscount` uses `>` rather than `>=`. Ten `node --test` cases, two of which fail
on that one comparison; the other eight pass so a regression in `testing` has something to break.
`totalCents` is the second failing case and exists so the bug is visible through a caller as well as
directly. Zero dependencies, so `npm ci` resolves the lockfile and corepack never runs.

## Stage 1 - contracts, schema, taxonomy

The whole migration surface of the milestone, in one place.

`packages/database/src/schema/job-artifact.ts`:

```text
job_artifacts
  id          bigserial primary key      -- monotonic, and the list cursor
  job_id      uuid not null references jobs on delete cascade
  type        text not null              -- zod-validated, not a pgEnum
  phase       text not null              -- the status that produced it
  content     text not null              -- bounded; head+tail with the elision stated inline
  byte_size   integer not null           -- the true size before truncation
  truncated   boolean not null default false
  metadata    jsonb
  created_at  timestamptz not null default now()
  index (job_id, id)
```

Append-only. Nothing updates a row, for the same reason nothing updates `job_events` or
`job_commands`: this is evidence, and evidence that can be edited is not evidence.

`type` is `text` validated by a new `ARTIFACT_TYPES` in `@rivet/contracts`, following
`JOB_EVENT_TYPES` rather than `JOB_STATUSES` - the vocabulary grows every milestone (plan in M6,
validation reports in M7, review reports in M8) and a migration per entry buys nothing. M5 declares
`diff`, `diff_stat`, `implementation_summary`.

Also in contracts:

- new `JOB_EVENT_TYPES`: `plan.deferred`, `artifact.recorded`, `validation.recorded`
- new `JobEventData` fields: `artifactId`, `artifactType`, `byteSize`, `truncated`, `validation`,
  `filesChanged`, `insertions`, `deletions` - each added to the type, the zod object, and
  `normalizeJobEventData`, which is three edits in one file and is easy to do only two of
- new `FAILURE_CATEGORIES`: `no_changes_produced`, `validation_failed`

Both new categories are terminal. `no_changes_produced` is terminal because a session that ended
cleanly having touched nothing will do it again. `validation_failed` is terminal because re-running
a whole model session on the chance of better sampling costs another container, another clone and
another bill to find out - and M6, not M5, is where resumption gets designed properly. New error
classes in `packages/core/src/jobs/failure.ts` plus their `classify()` arms.

The `jobs` table gains **no columns**. That falls out of the artifact decision and is worth keeping:
one new table, one migration, no change to the five `.update(jobs)` sites.

## Stage 2 - the artifact writer

New directory `packages/core/src/artifacts/`. AGENTS.md currently lists six permitted top-level
directories in `packages/core`; this stage adds the seventh and updates that list, which is the
honest way to add one rather than dropping a file next to `index.ts`.

- `recordArtifact()` is the only writer of `job_artifacts`, takes an `Executor` like `appendEvent`
  does, and bounds `content` itself so no caller can forget. Same head+tail elision as
  `command-output.ts`, and the same rule that the elided byte count is stated inline in the text.
- `listArtifacts()` / `getArtifact()` for the read side, returning metadata without content for the
  list and content for the fetch - the timeline is read in full on every render and a 200KB diff
  must never be part of that.
- `PhaseContext.artifact(input)` wires it to the transaction, writes the `artifact.recorded` event
  in the same transaction as the row, and returns the id. An event pointing at an artifact that does
  not exist is worse than no event, which is the argument `exec` already makes for `job_commands`.

The bound is a worker config value (`RIVET_ARTIFACT_MAX_BYTES`, default 256KB) passed into
`PipelineOptions`, not a constant in core. Same rule as every other limit.

## Stage 3 - the phase layout

- `analyzing` gets `baselinePhase`, and its label becomes something that says what it does.
- `testing` gets the new `validationPhase` from Stage 5.
- `planning` gets a body that emits one `plan.deferred` event and returns, with `durationMs: 0`. A
  two-second sleep inside an otherwise real job is a lie told to whoever is watching the demo, and
  removing the sleep without removing the status keeps M6's plan artifact a body to fill rather than
  a status to add back.
- The guard-table test that walks every pipeline `phases.ts` can build is updated and must still
  pass: the seven statuses remain a legal walk ending on `finalizing`.
- `docs/architecture.md` and `AGENTS.md` both describe the old layout in prose and both need the
  correction, including the "records a baseline" sentence and the M2/M3 phase diagrams.

Note that `job_commands.phase` for baseline commands changes from `testing` to `analyzing`. The
column is deliberately `text` and never joined as a state machine, so old rows keep their old value
and nothing breaks.

## Stage 4 - what the session is told

The context builder in `implementing-phase.ts` currently ends with:

> The repository's own test suite has NOT been run yet, so you have no baseline result to compare
> against.

After Stage 3 that sentence is false, and the sentence that replaces it is most of this stage's
value. Work:

- `readBaseline(jobId)` in `packages/core/src/events/`, reading the latest `baseline.recorded` row
  back out of the event log. Read back rather than threaded through a run-scoped object on purpose:
  M6 resumes a job in a new worker process, and a fact that only exists in the previous process's
  memory is a fact M6 has to re-derive. The event log is already the source of truth for replay.
- Context gains the baseline outcome, the exact test command, and - per PRD §14 step 1 - the head of
  `README.md` and the `scripts` block of `package.json`, each individually bounded. Bounded
  individually rather than as a total, so one enormous README cannot crowd out the file listing.
- The task instructions gain the two things completion detection depends on: run the test suite
  before declaring done, and end with a message describing what changed and why.
- `SessionAccounting` retains the last `assistant_message` text. This is the implementation summary,
  and it costs nothing because the event is already being written.

The alternatives for the summary - a `.rivet/summary.md` the model writes, or a second structured
model call - were both rejected for M5: the first adds a file that then has to be excluded from
every diff, and the second is a second provider dependency inside the phase, which PRD §41 lists as
later work. When the last message is absent or empty, the artifact records that plainly instead of
inventing one.

## Stage 5 - `testing` becomes validation

New `packages/core/src/pipeline/validation-phase.ts`. This is the milestone's centre of gravity.

1. `git add -A`, then `git diff --cached` and `git diff --cached --numstat`. Persist the diff as a
   `diff` artifact and the parsed stats as `diff_stat`. `--numstat` is parsed rather than `--stat`
   because it is machine-readable by construction and `--stat` is a display format that has changed
   before.
2. **Empty diff is a result, not an absence.** A session that ended with `stopReason: completed` and
   changed nothing failed to do the task while believing it succeeded, which is the most interesting
   failure mode this milestone can surface. `NoChangesProducedError`.
3. Re-detect the project and re-run the same script the baseline ran, with `baselineTimeoutMs`. Same
   asymmetry `baselinePhase` already establishes: a killed command is a fact about the sandbox and
   fails the job; a non-zero exit is a fact this phase interprets.
4. Compare, and record `validation.recorded`:

   | baseline  | after  | outcome      | job    |
   | --------- | ------ | ------------ | ------ |
   | `passed`  | passes | `verified`   | green  |
   | `passed`  | fails  | `regressed`  | failed |
   | `failed`  | passes | `fixed`      | green  |
   | `failed`  | fails  | `unresolved` | failed |
   | `skipped` | n/a    | `unverified` | green  |

`fixed` is the fixture's path and `verified` is the path a feature request takes. `unverified` stays
green deliberately: a repository with no `test` script is not a broken job, and failing it would
repeat exactly the mistake PRD §11 C exists to prevent. It is recorded as unverified so nobody reads
a green badge as a claim that was never checked.

The comparison itself is a pure function over `(baseline, exitCode)` and is unit-tested as a matrix
with no database, no container and no model.

## Stage 6 - `finalizing` becomes real

New `finalizing-phase.ts`, and it is deliberately small:

- persist the retained last assistant message as an `implementation_summary` artifact
- emit the closing event carrying the validation outcome and the diff stats, so the last line of the
  timeline states what happened rather than that something did

Branch, commit, push and PR are PRD §11 I and belong to M9. The sandbox is still destroyed by the
processor's `finally`, which is why this phase can read from it at all.

## Stage 7 - the web surface

- `GET /api/jobs/:id/artifacts` (PRD §19) listing metadata, and a fetch route for one artifact's
  content. `dynamic = "force-dynamic"`, no `runtime = "edge"`.
- An artifacts panel on the job detail page: the summary rendered as prose, the diff in a monospace
  viewer with per-line add/remove colouring. No new dependency and no syntax highlighting - a diff
  reads fine with two background colours, and a highlighter is 200KB of client bundle for a demo
  nobody is squinting at.
- Timeline rendering for `validation.recorded`, `artifact.recorded` and `plan.deferred` in
  `live-execution-timeline.tsx`.
- Artifacts are fetched by the server component, not streamed. They are written once, near the end,
  and the live provider already performs one `router.refresh()` after `stream.end`, so they appear
  without a second transport.

## Stage 8 - verification

Nothing here needs a model key, which is the property that keeps CI meaningful.

- **Unit** (`pnpm test`, no infrastructure): the outcome matrix; `--numstat` parsing including
  binary files, renames and an empty diff; artifact truncation and its byte accounting; the context
  builder with each of the three baseline outcomes; `readBaseline` against a synthetic event list.
- **Integration** (`*.int.test.ts`, Postgres + Redis + the scripted sandbox fake): the full run with
  a scripted agent - a green run producing a `fixed` outcome, a run producing an empty diff, a run
  producing a regression, and a cancellation between the session and validation that still leaves
  the diff artifact behind. Needs canned `git diff` responses in the fake, which is a small addition
  to its script table.
- **Sandbox** (`*.sbx.test.ts`, real Docker): a real repository, a real edit, a real `git diff`, and
  a diff deliberately larger than the artifact bound so truncation is proved against the real thing
  rather than a string.
- **Streaming** (`pnpm test:streaming`): the new event types replay and stream like every other row.
- **`pnpm demo:job`**: the definition of done, end to end, against `rivet-fixture-node` with a real
  Pi session. Local only and not in CI, for the same reason `demo:agent` is not: third-party
  provider availability is not a build dependency.

Then the usual gate: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` with no
database, no Redis and no Docker.

---

## Definition of done

A job created against `rivet-fixture-node` with the seeded bug as its description walks
`queued -> provisioning -> analyzing -> planning -> implementing -> testing -> reviewing -> finalizing -> completed`
with no human intervention, and leaves behind:

- a `baseline.recorded` event saying the suite was red before anything was touched
- a Pi session whose turns, tool calls, commands and spend are all on the timeline
- a `diff` artifact containing the fix
- a `validation.recorded` event with outcome `fixed`
- an `implementation_summary` artifact
- a destroyed container

And the negative half, which matters as much: a job whose session changes nothing fails with
`no_changes_produced`, and a job whose session breaks a green suite fails with `validation_failed`.
An M5 that can only report success has not validated anything.

## Risks

- **Model non-determinism against a fixed demo.** Mitigated by making the fixture trivial, and by
  the fact that the interesting output of a failed run is now an artifact and a validation outcome
  rather than a shrug.
- **Context growth.** Baseline text, README head and manifest scripts all land in the first prompt.
  Each is individually bounded; the tracked-file cap of 300 stays.
- **An empty last assistant message.** Some sessions end on a tool call. The summary artifact
  records that honestly rather than falling back to a synthesized one.
- **`git add -A` in a repository with a thin `.gitignore`.** Build output would land in the diff and
  hit the truncation bound. Visible rather than silent, because `truncated` and `byte_size` are both
  persisted, and worth watching on the first real repository.
- **`reviewing` is still a sleep.** M5 does not touch it; M8 owns it. Worth saying out loud so the
  demo narration does not imply a review happened.

## Deliberate limits

M5 does not claim a plan artifact (M6), checkpoint or resume (M6), lint and typecheck validation or
per-repository validation config (M7), an independent review session (M8), a branch, commit or pull
request (M9), or object storage for artifacts. It also does not add an outer repair loop: when the
model's own debugging fails, M5's job is to notice and say so.
