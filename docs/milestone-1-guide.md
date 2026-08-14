# Milestone 1: a guided tour

This is a learning document. `docs/architecture.md` describes **what the system is**; this describes
**why it is that way**, in the order that makes it easiest to understand, debug, and extend.

Read this if you want to answer questions like: why is there a lease when BullMQ already has locks?
What actually happens when I `kill -9` a worker? Where would I add a new phase? Why did my job go
back to `queued` on its own?

Everything here is checked against the code as of commit `ffc7ba2`. Where the milestone plan
(`docs/plans/milestone-1.md`) and the code disagree, the code is right and this document follows the
code.

---

## Part 0. The one idea

If you remember nothing else, remember this:

> **Postgres holds job state. Redis holds nothing that matters.**

Redis is a delivery mechanism. It carries one UUID from the web app to a worker, and that is the
entire extent of its responsibility. Every fact about a job - what status it is in, who owns it, how
many times it has been attempted, what went wrong - lives in Postgres.

The test of whether that claim is true: **flush Redis completely and no job is lost.** Every row
that says `queued` still runs, one sweep interval later. That property is not automatic. It is
bought by three specific pieces of machinery (the lease, the compare-and-swap, and the sweeper), and
most of this document is an explanation of why each one is necessary.

The reason to care: the whole point of Milestone 1 is not "a worker that sleeps for 20 seconds". It
is the durable execution substrate that later milestones plug into. When Milestone 2 replaces the
simulated phases with real sandbox calls, none of the claiming, leasing, heartbeating, retrying, or
recovering should have to change.

---

## Part 1. A reading path

The code is heavily commented, and reading it in the right order is the fastest way in. Roughly 90
minutes, in this sequence:

| #   | File                                         | What it teaches                                 |
| --- | -------------------------------------------- | ----------------------------------------------- |
| 1   | `packages/core/src/jobs/transitions.ts`      | The single writer rule and the compare-and-swap |
| 2   | `packages/core/src/jobs/claims.ts`           | Ownership: claim, heartbeat, release            |
| 3   | `apps/worker/src/heartbeat.ts`               | How a run is aborted from outside               |
| 4   | `apps/worker/src/processor.ts`               | One full run, claim to terminal status          |
| 5   | `packages/core/src/jobs/failure.ts`          | Why an unknown error is terminal                |
| 6   | `packages/core/src/jobs/sweeper.ts`          | The two leaks and the reconciliation loop       |
| 7   | `packages/queue/src/bull-queue.ts`           | Idempotency, and the BullMQ v6 traps            |
| 8   | `packages/core/src/pipeline/run-pipeline.ts` | Why the runner takes everything as arguments    |

Then run the integration suite and read the test names. They are written as sentences and they are
the executable version of this document:

```bash
pnpm --filter @rivet/worker test:integration
```

---

## Part 2. The five mechanisms

Each one is presented the same way: the problem, the solution, what breaks without it, and where to
look.

### 2.1 The lease: who is allowed to run this job

**The problem.** A worker picks up a job and starts working. It is killed with `kill -9`. Nothing is
told: not Redis, not Postgres. The row sits in `implementing` forever, and no other worker can
safely touch it, because how would a second worker know the first one is dead rather than slow?

**Why not BullMQ's locks?** BullMQ does have locks and stalled-job detection, and they work. But
they reason about the **message**, not the **job**. A message whose worker vanished mid-run tells
you nothing about how far the job got or whether it is safe to start over. The two are different
objects with different lifetimes: one job can be carried by several messages across retries and
reclaims. Putting ownership in the same database as the job means "who owns this, and are they
alive" is answerable by a single query against the source of truth.

**The solution.** Three columns on `jobs`:

```
lease_owner        who holds it (a worker id)
lease_expires_at   until when
heartbeat_at       when they last said something
```

A lease that has expired on a non-terminal job means the holder is gone, whatever Redis believes.
That single fact is what the sweeper acts on.

**What breaks without it.** Two workers run the same job simultaneously, each unaware of the other,
both writing status. Or a crashed job is stuck forever with nothing willing to claim it.

**Code:** `packages/core/src/jobs/claims.ts`

---

### 2.2 The heartbeat: three concerns, one round trip

This is the most elegant thing in the milestone and worth understanding properly.

Every ten seconds, a running worker issues **one** `UPDATE`:

```sql
UPDATE jobs
   SET heartbeat_at = now(),
       lease_expires_at = now() + interval '30 seconds'
 WHERE id = $1 AND lease_owner = $2
RETURNING cancel_requested_at, status;
```

That single statement does three jobs at once:

1. **Liveness.** Pushing `lease_expires_at` forward is how a healthy worker tells the sweeper to
   leave its job alone.
2. **Fencing.** The `lease_owner = $2` predicate. If something reclaimed this job, zero rows come
   back, and the worker knows it has been fenced out. It must abort immediately and write nothing
   further.
3. **Cancellation delivery.** `cancel_requested_at` comes back on the same row. Cancel therefore
   needs no pub/sub channel and no poll of its own: the API stamps a column, and the worker notices
   within one interval.

Three mechanisms that most systems build separately, collapsed into one query that was going to
happen anyway.

**The invariant: `heartbeat * 3 <= lease`.** Defaults are 10s and 30s. It is asserted at worker
startup and the process refuses to boot if violated. The reason is worth internalising: a worker
whose heartbeat interval is longer than its lease will have its jobs stolen by the sweeper **while
it is perfectly healthy**. The resulting duplicate execution is miserable to diagnose because
nothing looks broken. Three heartbeats of slack means one slow query and one dropped packet are both
survivable.

That slack is also why a _failed_ heartbeat is not a failed job. It logs and retries on the next
interval. If the database really is gone, the lease lapses on its own and the sweeper does the right
thing, which is a better outcome than a worker killing a healthy job over one dropped connection.

**Code:** `packages/core/src/jobs/claims.ts` (`heartbeat`), `apps/worker/src/heartbeat.ts` (the
loop)

---

### 2.3 The transition guard: one writer, and it cannot be clobbered

**The problem.** Status is the most contended field in the system. A worker wants to advance it, a
cancel wants to end it, a sweeper wants to reclaim it - potentially at the same instant.

**The solution.** Exactly one function writes `jobs.status`: `transitionJob()`. Two properties fall
out of it:

**Legality.** A guard table declares which edges exist. Anything absent throws before touching the
database:

```ts
queued:       ["provisioning", "cancelled", "failed"],
implementing: ["testing", "failed", "cancelled", "timed_out", "budget_exceeded", "queued"],
completed:    [],   // terminal statuses have no outgoing edges
```

The `-> queued` edge on every in-flight status is the reclaim path. A sweeper putting an orphaned
job back on the queue is an ordinary legal transition, not a special case that bypasses the guard.

**Compare-and-swap.** The update carries its own preconditions, so there is no read-then-write race
to lose. `status IN (from)` is the compare-and-swap and `lease_owner = ...` is the fence. Zero rows
updated means someone else got there first, and that raises `TransitionConflictError` - which
callers treat as "stand down", never as "retry harder".

Atomically with the status write, an event row is inserted. Same transaction, always. This is why
Milestone 0 chose the `pg` driver over Neon's HTTP driver: interactive transactions.

**How the rule is enforced.** Not by convention. `TransitionInput["patch"]` is typed
`Omit<Partial<NewJob>, "status">`, so writing status through any other path is a **compile error**.
There are exactly three `.update(jobs)` sites in `packages/`, and you can verify it yourself:

```bash
grep -rn "\.update(jobs)" --include="*.ts" packages | grep -v node_modules
```

The other two are `claims.ts` (heartbeat, lease columns only) and `cancel.ts` (the
`cancel_requested_at` stamp only). Neither touches status.

**One consequence to know:** the guard rejects same-status transitions, because no status lists
itself. A worker must never call `transitionJob` to "refresh" a job in place. This is also why the
first phase of the pipeline appends a bare event rather than transitioning - the claim already moved
the job into `provisioning`.

**Code:** `packages/core/src/jobs/transitions.ts`

---

### 2.4 The sweeper: two leaks, opposite directions

The sweeper is what turns "Postgres is the source of truth" from aspiration into fact. It closes two
independent leaks that fail in opposite directions.

**Leak 1: a job Postgres thinks is running, that nothing is running.**

A worker was `kill -9`'d, OOM'd, or its container vanished. It left a row in a leased status whose
`lease_expires_at` has quietly passed. `reclaimExpiredJobs` scans for exactly that and decides one
of four outcomes, in priority order:

| Condition                      | Outcome                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| A cancel was already requested | Short-circuit to `cancelled`                                 |
| Attempts exhausted             | `failed`, category `lease_expired`                           |
| Attempts remain                | Back to `queued`, lease cleared, `job.reclaimed`, re-enqueue |
| Someone else got there first   | `skipped`, writes nothing                                    |

The cancel check comes **first**, deliberately. A job whose worker died after a cancel was stamped
should not resume: someone asked for it to stop, the only reason it did not is that its worker was
killed, and a job visibly resuming after a cancel is the kind of thing nobody trusts again. Checking
it before the attempt ceiling also stops a cancelled job being recorded as `failed` just because it
happened to be on its last attempt.

**Leak 2: a job Postgres thinks is queued, that no message points at.**

This is the dual-write gap. See Part 5.3 - it has its own entry because it is the single most
interview-worthy decision in the milestone.

**`SKIP LOCKED` is a throughput property, not a correctness one.** This trips people up. The scan
uses `FOR UPDATE ... SKIP LOCKED` so several workers can sweep on the same schedule without queueing
up behind each other. But the lock is released by that statement alone and is _not_ held across the
transitions that follow - it cannot be, because those need to enqueue afterwards, and holding a
Postgres transaction open across a Redis round trip is a bad trade. Correctness comes from
`transitionJob`'s compare-and-swap. If two sweepers do pick the same job, the second one's
transition finds a status it did not expect and returns `skipped`.

**Code:** `packages/core/src/jobs/sweeper.ts`

---

### 2.5 Idempotent enqueue, and the BullMQ v6 trap

The BullMQ message id **is** the Postgres job UUID. That one decision makes enqueueing idempotent:
two retries of the same `POST /api/jobs` cannot produce two executions.

It also creates a trap that is worth understanding because it would have been very hard to debug.

**A completed BullMQ job keeps its id reserved.** So if you keep a debugging window of completed
messages (`removeOnComplete: { age: 3600 }`, as the plan originally specified), then every later
re-enqueue of that same job - a retry, a sweeper reclaim - **silently deduplicates against a message
that already ran**. Jobs would simply stop coming back, with no error anywhere.

The fix is explicit in the adapter: look the id up first, and if it exists in a finished state,
`remove()` it before adding. Retries and sweeper reclaims both take this path.

```ts
const existing = await this.queue.getJob(jobId);
if (existing) {
  const state = await existing.getState();
  if (!FINISHED_STATES.has(state)) return "already-queued";
  await existing.remove(); // free the id so the new message is really created
}
await this.queue.add(JOB_NAMES.runJob, { jobId }, { jobId });
```

**Other BullMQ v6 differences** (v6 shipped 2026-07-30; nearly all material online describes v5):

- The legacy repeatable-jobs API is gone. Use Job Schedulers (`upsertJobScheduler`). It is keyed on
  the scheduler id, so every worker calling it at startup produces one schedule, not one per worker,
  and it survives restarts because it lives in Redis rather than a `setInterval`.
- `job.discard()` is replaced by throwing `UnrecoverableError`.
- `Queue#client` and `Worker#blockingClient` no longer exist.
- The processor signature is `(job, token, signal)`, where the third argument is a lock-loss signal.
  Rivet deliberately declares only two parameters: the Postgres lease is the authority on ownership,
  and a second opinion would invite split-brain.
- `DelayedError` + `job.moveToDelayed()` is how you hand a message back **without** consuming an
  attempt. This is what graceful shutdown uses.

**Code:** `packages/queue/src/bull-queue.ts`

---

## Part 3. Trace a job end to end

The happy path, with every write named. This is the mental model to debug against.

```
1. POST /api/jobs
   Postgres: INSERT jobs (status=queued) + job.created      [one transaction]
   Redis:    add message, id = job UUID
   Postgres: job.enqueued
   -> 201, even if the enqueue failed (the row exists; the sweeper will find it)

2. Worker receives the message (which contains only a jobId)
   claimJob: status queued -> provisioning, lease_owner set,
             lease_expires_at = now + 30s, attempt_count += 1,
             started_at = coalesce(started_at, now)          [one transaction]
   -> null instead means: cancelled, already terminal, or another worker won.
      Not an error. Return.

3. Heartbeat starts, every 10s, until the run ends

4. For each of the 7 phases:
   onPhaseStart    -> transitionJob to the phase status + phase.started event
   sleep(duration * speed)
   onPhaseComplete -> phase.completed event with the real elapsed ms

5. transitionJob: finalizing -> completed, completed_at set,
   lease cleared, job.completed event

6. Heartbeat stops, deadline timer cleared, run deregistered
```

Note step 2's `coalesce(started_at, now)`: a reclaimed job keeps its **original** start time, so
end-to-end duration stays honest across a crash.

**The shape to hold on to: BullMQ delivers a job id and nothing else.** Everything that matters is a
Postgres write guarded by the lease. That is what makes a lost message, a duplicated message, or a
message for a job that finished ten minutes ago all harmless.

---

## Part 4. When things go wrong

One error, two systems that need an answer. Postgres needs a status and a `failure_category`; BullMQ
needs to know whether to retry. `classify()` produces both from one decision, which is what stops
them drifting apart.

| Class           | Postgres                        | BullMQ                           | Why                                               |
| --------------- | ------------------------------- | -------------------------------- | ------------------------------------------------- |
| `lease_lost`    | **nothing at all**              | returns normally                 | Another worker owns it. Any write is split-brain. |
| `shutting_down` | back to `queued`, lease cleared | `moveToDelayed`, no attempt used | A deploy is not a job failure                     |
| `cancelled`     | `cancelled`                     | finishes normally                | A cancelled job is not a failed job               |
| `timed_out`     | `timed_out`                     | `UnrecoverableError`             | It will blow the same budget again                |
| `retryable`     | back to `queued`                | rethrow, backoff applies         | A fresh attempt might get past it                 |
| `terminal`      | `failed` + category             | `UnrecoverableError`             | A fresh attempt would hit the same thing          |

**The default is the important part: an unrecognised error is `terminal`, not `retryable`.**
Retrying an error nobody has reasoned about is how one bug becomes three identical bugs, a tripled
bill, and a timeline three times as hard to read. Retryability is a _claim_ about an error, and a
claim has to be made deliberately by throwing `RetryableJobError`.

**`lease_lost` writing nothing is not an oversight.** It is the single most important line in the
failure handler. Not a status, not an event, not a lease clear. The job's replacement is mid-flight
and every write from here lands in the middle of someone else's run.

### Two counters, and which one is true

- `job.attemptsMade` - BullMQ's per-**message** retry count.
- `jobs.attempt_count` - how many times any worker has **claimed** this job, including reclaims
  after crashes BullMQ never heard about.

Both are logged. **Postgres is the one that is true.** Note also that the sweeper does not bump
`attempt_count` when it reclaims; the next claim does. That keeps the counter meaning "times a
worker picked this up" rather than "times something touched it".

---

## Part 5. Decision log

The reasoning behind the choices, including what would change them.

### 5.1 Postgres lease on top of BullMQ, rather than trusting BullMQ alone

**Alternatives:** BullMQ's stalled-job detection alone; a distributed lock in Redis (Redlock).

**Why this:** BullMQ's locks describe a message, not a job. Rivet needs to answer "is it safe to
start this job over", which requires knowing how far it got - and that lives in Postgres. Putting
ownership next to state means one query answers both.

**What would change it:** if job state ever moved out of Postgres, this stops paying for itself.

### 5.2 Port and adapter around the queue

`packages/core` defines `interface JobQueue`. `packages/queue` implements it twice: BullMQ for real,
an in-memory array for tests.

**Why:** if `packages/core` imported `bullmq`, the domain logic would depend on the delivery
mechanism, and the claim that Redis holds nothing that matters would stop being architecturally
true. The practical payoff is that `pnpm test` runs the whole domain layer with no Redis and no
database. It is the same boundary shape the PRD asks for around Pi in §8, applied a milestone early.

### 5.3 No transactional outbox (the dual-write gap)

**This is the one to be able to discuss.** `POST /api/jobs` commits the row, and _then_ sends the
message. There is no distributed transaction between Postgres and Redis. If the process dies in
between, Postgres says `queued` and Redis has nothing.

**The honest answer for M1:** the insert commits first, and the sweeper is the reconciliation loop
that makes the window survivable. Any row that says `queued` will eventually run, whether or not the
message that was supposed to carry it ever arrived.

**The stronger answer, deliberately not built:** a transactional outbox - write the message intent
into a Postgres table in the same transaction as the row, and have a relay process ship it to Redis.
It buys correctness this design already gets from reconciliation, at the cost of a second table and
another moving part.

**What would change it:** if sweep latency (up to a minute) became unacceptable for the
enqueue-failed path, or if the number of dual-write sites grew beyond one.

### 5.4 Event types and failure categories are `text`, not `pgEnum`

The status enum is a closed state machine that is indexed and queried on, so it earns a real
Postgres enum plus a type-level drift assertion. The event vocabulary and failure taxonomy churn
every milestone, and paying a migration per new category is not worth it. They are validated by Zod
instead.

### 5.5 The pipeline runner takes every dependency as an argument

The clock, the sleep, both callbacks, the fault injector, the abort signal. Nothing imported,
nothing read from the environment.

**Payoff:** the whole pipeline runs in well under a millisecond at `speed: 0`. No `vi.useFakeTimers`
gymnastics, no test that sleeps in CI. And Milestone 2 swaps the phase bodies for sandbox calls
without the runner noticing.

### 5.6 A failed enqueue still returns 201

The job is durably persisted and the sweeper will pick it up within a minute. Failing the request
would be a lie: the job does exist. The failure is logged and appended to the timeline as
`job.enqueue_failed`, so the job's own history shows why nothing happened for a minute.

---

## Part 6. Debugging playbook

| Symptom                                         | Check first                                                                    | Likely cause                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Job stuck in `queued`, worker idle              | Is the worker running? `job_events` for `job.enqueued` vs `job.enqueue_failed` | Enqueue failed; wait one sweep (60s) or check `REDIS_URL`                                 |
| Job stuck in `queued`, no `job.enqueued` at all | Redis reachable?                                                               | The dual-write gap. The sweeper repairs it after `DEFAULT_ORPHANED_QUEUED_AFTER_MS` (60s) |
| Job bounces `queued` -> running -> `queued`     | `attempt_count`, and the `job.reclaimed` events                                | Lease expiring under a healthy worker. Check `heartbeat * 3 <= lease`                     |
| Two workers appear to run one job               | `lease_owner` history in `job_events`                                          | Should be impossible. If real, something bypassed `transitionJob`                         |
| `TransitionConflictError` in the logs           | Usually benign                                                                 | Something got there first: a cancel, a sweeper reclaim. The loser correctly wrote nothing |
| Job never comes back after a retry              | `queue.getJob(jobId)` state in Redis                                           | The finished-message id trap. See 2.5                                                     |
| Crash recovery takes longer than a sweep        | Expected                                                                       | See Part 8.1 - bounded by BullMQ's stalled detection, not by the sweep                    |
| `pnpm build` fails in CI                        | Did you add a DB-reading page without `dynamic = "force-dynamic"`?             | The build must work with no `DATABASE_URL` at all                                         |

**The timeline is the primary debugging tool.** `job_events` is append-only, ordered, and written in
the same transaction as the status change it records, so it cannot disagree with the row. Read it
first:

```sql
SELECT id, type, message, data, created_at
  FROM job_events WHERE job_id = '...' ORDER BY id;
```

**Reproducing failures on demand.** The fault injector exists precisely so the recovery machinery
has something to recover from:

```bash
RIVET_FAULT_PHASE=testing RIVET_FAULT_MODE=throw  pnpm --filter @rivet/worker dev  # retry + backoff
RIVET_FAULT_PHASE=testing RIVET_FAULT_MODE=fatal  pnpm --filter @rivet/worker dev  # terminal, no retry
RIVET_FAULT_PHASE=testing RIVET_FAULT_MODE=hang   pnpm --filter @rivet/worker dev  # timeout path
RIVET_FAULT_PHASE=testing RIVET_FAULT_MODE=exit   pnpm --filter @rivet/worker dev  # kill -9, sweeper reclaim
```

`exit` is the Milestone 6 demo, available five milestones early.

---

## Part 7. Extending the system

### Add a job status

1. Add it to `JOB_STATUSES` in `packages/contracts/src/job.ts` **and** the `job_status` pgEnum in
   `packages/database/src/schema/job.ts`. A type-level assertion fails typecheck in both directions
   if you do only one.
2. Give it edges in `ALLOWED_TRANSITIONS`. A test asserts every status is present.
3. Give it a colour in `StatusBadge` (a total `Record<JobStatus, ...>`, so typecheck breaks until
   you do).
4. `pnpm db:generate`, commit the SQL, `pnpm db:migrate`.

**Adding** a Postgres enum value is a cheap migration. Reordering or removing one is not. Prefer
adding.

### Add an event type

Add it to `JOB_EVENT_TYPES` in contracts and give it a tone in `JOB_EVENT_TONE`. No migration - the
column is `text` on purpose. See 5.4.

### Add or change a pipeline phase

Edit `SIMULATED_PIPELINE` in `packages/core/src/pipeline/phases.ts`. A unit test asserts the phase
statuses form a legal path through `ALLOWED_TRANSITIONS`, so an illegal ordering fails fast rather
than at runtime.

### What Milestone 2 replaces

Only the phase **bodies**. `runPipeline` takes its callbacks as arguments precisely so the sandbox
work slots in without the runner, the lease, the heartbeat, the sweeper, or the transition guard
changing at all. If an M2 change forces you to modify `claims.ts` or `transitions.ts`, that is a
signal something has been designed wrong.

Also deleted in M2: the fault injector, `RIVET_PIPELINE_SPEED`, and the `simulated_failure` failure
category.

### Milestone 3 follow-up

The job detail page now uses `GET /api/jobs/:id/events?after=<id>` as a content-negotiated SSE
stream. The durable cursor contract described here is unchanged: reconnects use the event id, and
the client reduces replayed rows idempotently. The temporary page-refresh mechanism from the M1/M2
demo is gone.

---

## Part 8. Sharp edges and known limits

### 8.1 Crash recovery is bounded by BullMQ, not by the sweep

After a `kill -9`, the sweeper puts the row back in `queued` promptly. But the dead worker's message
is still sitting in Redis marked `active`, because nothing told Redis either. The adapter will not
displace a message that is not finished, so the re-enqueue answers `already-queued` and no
redelivery happens from the sweep.

**Consequence:** end-to-end recovery takes as long as the _slower_ of two independent mechanisms -
Rivet's lease expiry plus a sweep interval, or BullMQ's `lockDuration` plus `stalledInterval`. Both
are on the order of a minute by default.

Neither can be dropped: BullMQ's half cannot see the job row, and Rivet's half cannot displace a
live message. This is correct, but it is a latency floor worth knowing before promising recovery
times.

### 8.2 Cost: Upstash bills per command, Neon bills compute hours

BullMQ polls Redis even when idle, and a sweep every 60 seconds keeps Neon's compute endpoint awake
permanently, defeating autosuspend. **Stop the worker when you are not actively developing.**
Mitigations already applied: `drainDelay: 30` (cuts the idle command rate roughly 6x versus the 5s
default), a 60s sweep rather than 10s, and small retention windows.

### 8.3 The integration suite truncates tables

`apps/worker/tests/integration/env.ts` deliberately does **not** load `.env.local`, and refuses to
run against any non-local host. Every test truncates `jobs` and `job_events`, `.env.local` points at
real Neon on every developer machine, and the failure mode would be silent and total. The escape
hatch is `RIVET_ALLOW_REMOTE_INTEGRATION=1`, and having to say it out loud is the entire mechanism.

### 8.4 Running the suite locally

Needs a local Postgres and Redis. Docker is the intended route and is what CI uses. On a machine
without it, Homebrew works, with one wrinkle: Homebrew's Redis 8.10 service aborts at startup trying
to load bloom modules by relative path, so start it directly.

```bash
brew services start postgresql@17
redis-server --port 6379 --daemonize yes --save "" --appendonly no
psql -d postgres -c "CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'postgres';"
psql -d postgres -c "CREATE DATABASE rivet_test OWNER postgres;"
pnpm test:integration
```

### 8.5 Upstash credentials

BullMQ needs a **TCP** connection through ioredis. The `UPSTASH_REDIS_REST_URL` / `_REST_TOKEN` pair
is the REST API and will not work. The TCP endpoint is the same database on port 6379 over TLS, and
the REST token doubles as the Redis password:

```
REDIS_URL="rediss://default:<REST_TOKEN>@<host>.upstash.io:6379"
```

---

## Glossary

| Term                 | Meaning                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------ |
| **Lease**            | Time-bound ownership of a job by one worker, held in Postgres                              |
| **Fencing**          | Using `lease_owner` as a predicate so a reclaimed worker's writes fail rather than corrupt |
| **Compare-and-swap** | An update whose `WHERE` carries the expected prior state; zero rows means someone else won |
| **Reclaim**          | The sweeper returning an orphaned job to `queued`                                          |
| **Sweep**            | One reconciliation pass over both leaks                                                    |
| **Dual-write gap**   | The window between the row committing and the message being sent                           |
| **Port / adapter**   | An interface in `core` (port) with swappable implementations outside it (adapters)         |
| **Split-brain**      | Two workers acting on one job, each believing it is the owner                              |
| **Orphaned row**     | A `queued` job with no message behind it                                                   |
| **Terminal status**  | `completed`, `failed`, `cancelled`, `budget_exceeded`, `timed_out`. No outgoing edges      |

---

## Where to go next

- `docs/architecture.md` - the system as it is, in reference form
- `docs/plans/milestone-1.md` - the plan this was built from, including what changed along the way
- `apps/worker/tests/integration/` - the twelve behaviours from the plan, as executable prose
- `AGENTS.md` - the invariants, in the form future contributors will meet them
