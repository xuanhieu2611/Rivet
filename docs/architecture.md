# Architecture

This document describes Rivet **as it exists today**, at the end of Milestone 1, and names the
places where the current shape is a deliberate shortcut rather than the intended end state. It is
updated as each milestone lands rather than describing a system that does not exist yet.

## The target, in one picture

The system Rivet is being built towards is a control plane that owns job lifecycle, with workers
that run a coding agent inside disposable sandboxes:

```text
   Web UI  ──HTTPS/SSE──▶  Control plane  ──▶  Postgres (state)
                                │
                                └──▶  Redis queue  ──▶  Workers
                                                          │
                                                          ▼
                                               Orchestrator + sandbox
                                                          │
                                          clone · edit · test · review · PR
```

Milestone 0 built the leftmost column: a UI, an API, and durable job state. Milestone 1 built the
queue, the worker, and everything that makes a job survive the worker dying. What is downstream of
the worker - the sandbox, the coding agent, the model - arrives in Milestones 2 through 5, and the
phases are simulated until then.

## What exists today

| Component     | Where                | Responsibility                                                          |
| ------------- | -------------------- | ----------------------------------------------------------------------- |
| Web UI        | `apps/web/app`       | Dashboard, new-job form, job detail with the execution timeline         |
| HTTP API      | `apps/web/app/api`   | `GET`/`POST /api/jobs`, `GET /api/jobs/:id`, `/events`, `/cancel`       |
| Worker        | `apps/worker`        | BullMQ consumer: claim, heartbeat, run the pipeline, finalize, sweep    |
| Domain logic  | `packages/core`      | Jobs, transitions, claims, cancellation, the event log, the pipeline    |
| Queue adapter | `packages/queue`     | BullMQ over Redis behind core's `JobQueue` port, plus an in-memory fake |
| Contracts     | `packages/contracts` | Zod schemas, the status enum, `JobSummary` / `JobDetail` / `JobEvent`   |
| Data access   | `packages/database`  | Drizzle schema, generated migrations, the `pg` pool                     |
| Shared config | `packages/config`    | The tsconfig and ESLint bases every workspace extends                   |

Two tables. `jobs` holds the domain model: the task the user described, the repository and base
branch, a `job_status` enum covering the full fourteen-state lifecycle, budget ceilings, the lease
and retry columns Milestone 1 added, and the result columns later milestones fill in. `job_events`
is the append-only history behind the execution timeline. Columns that only have a value once a
later milestone is real are nullable, so the sandbox and the agent will not need a migration to
start writing them.

## The two deployables and the package they share

Rivet runs as two processes: `apps/web`, which is Next.js, and `apps/worker`, which is a long-lived
Node process under `tsx` with no build step. Both are thin. Everything that decides what happens to
a job lives in `packages/core`, and both processes call it directly as a library.

That is the resolution of Milestone 0's open question about extracting `apps/api`, and it is worth
being precise about why the answer changed. The M0 shortcut was that business logic lived in
`apps/web` with no service boundary, and the stated trigger for paying that cost was "when the
worker appears, two processes will need job state". The worker did appear - and the thing two
processes actually needed turned out to be **the same code**, not the same HTTP endpoint. A control
plane API would have meant the worker POSTing its own status transitions back to the web app, which
buys a network hop, a serialization format, an auth story and a second failure mode, in exchange for
a boundary that nothing yet needs to enforce. A shared package gives both processes the identical
compare-and-swap against the identical database, with no boundary to keep in sync.

What survives is the discipline that made either option available. `packages/core` has no `next/*`
import, so nothing in it is coupled to the web app; if an HTTP boundary is ever genuinely needed -
workers on untrusted infrastructure, third-party workers, a rate limit that has to live somewhere
central - `apps/api` becomes a thin HTTP skin over the same package rather than a rewrite. The
interim rule from M0 still stands: route handlers do parse, validate, delegate, respond, and nothing
else. Orchestration accumulating in a `route.ts` is the signal that something belongs in core.

Two more rules keep the package honest, and both are load-bearing rather than stylistic. It imports
no `bullmq` and no `ioredis`, because domain logic that depends on the delivery mechanism cannot
claim to be independent of it - core declares a `JobQueue` interface and `packages/queue` is the
only place that knows Redis exists. And it reads no `process.env`: configuration arrives as
arguments, which is what lets the pipeline run at `speed: 0` in unit tests, in under a millisecond,
with no fake timers.

## How a request flows

Two entry points, one path underneath. A page renders on the server and calls core directly - there
is no HTTP hop from a server component to the app's own route handler:

```text
browser
  │
  ├── page navigation ────▶ React server component  ┐
  │                          (apps/web/app/**)      │
  │                                                 ├──▶ @rivet/core ──▶ Drizzle ──▶ pg Pool ──▶ Neon
  └── fetch() from the ───▶ route handler           ┘   (business        (query
      form / cancel button   (app/api/jobs/**)          logic)           builder)
                             zod validate
```

The route handlers stay thin on purpose: parse the body, validate it with a schema from
`@rivet/contracts`, delegate to core, map the result to a status code. Validation errors come back
as `400` with field-level detail; anything unexpected is logged server-side and returned as a
generic `500`, never as a database error string.

`POST /api/jobs` is the one handler that does two things: it persists the row and then asks for a
run. The second half deliberately cannot fail the request - see the dual-write section below.
`POST /api/jobs/:id/cancel` returns three different codes because there are genuinely three
different outcomes: `200` when the job had not started and is now `cancelled`, `202` when a worker
holds it and the request has only been recorded, `409` when it already finished.
`GET /api/jobs/:id/events?after=<id>` is the timeline's incremental read, and its cursor is designed
now precisely so Milestone 3 changes the transport to SSE without changing the contract.

Every page and route handler that touches the database sets `dynamic = "force-dynamic"`. That is
what lets `pnpm build` - and therefore CI - run with no database and no Redis at all: nothing is
prerendered, so nothing connects at build time.

## The queue

BullMQ on Redis, behind a port. `packages/core` declares the whole of what the domain needs from a
queue, which is three methods:

```ts
interface JobQueue {
  enqueueJobRun(jobId: string, options?: EnqueueOptions): Promise<EnqueueResult>;
  removeJobRun(jobId: string): Promise<boolean>;
  close(): Promise<void>;
}
```

`packages/queue` implements it twice: `BullJobQueue` for the real system, and `InMemoryJobQueue`,
which is an array, for tests. The fake is what keeps the entire unit suite runnable with no Redis,
which is in turn what keeps CI's `verify` job able to prove that `pnpm build` needs no environment.

**The message is a job id and nothing else.** Anything more copied into the payload would be a
second copy of state that can go stale between the enqueue and the moment a worker picks it up. A
worker that receives a message reads everything it needs from Postgres, under a lease.

The interesting decisions are all about idempotency, and they all follow from one choice: **the
BullMQ message id is the job's own UUID.** Two `POST /api/jobs` retries of the same create cannot
produce two executions, and the API, the retry path and the sweeper can all call `enqueueJobRun`
without coordinating.

That choice has a sharp edge in BullMQ v6 that is worth writing down, because everything depends on
it. A _completed_ message keeps its id reserved. Adding the same id again is silently deduplicated
against the message that already ran, so a retry or a sweeper reclaim would enqueue nothing at all.
`enqueueJobRun` therefore looks the id up first: if a message exists and is still waiting, delayed
or active, it answers `already-queued` and does nothing; if the message is finished, it removes it
and adds a fresh one. Retention is deliberately short for the same reason (`removeOnComplete` after
five minutes) - Redis is not the audit log, `job_events` in Postgres is.

Other v6 specifics that cost time to rediscover: `UnrecoverableError` replaced `job.discard()` as
the way to refuse a retry; the legacy repeatable-jobs API is gone in favour of job schedulers, which
is how the sweep is registered; and `Queue#client` and `Worker#blockingClient` no longer exist.
Nearly everything written about BullMQ online describes v5.

Redis is reached through one lazily-created, memoized ioredis client. Importing `@rivet/queue` never
opens a connection and never throws, exactly like `@rivet/database`, because `next build` runs in CI
with no `REDIS_URL`. Outside production both the client and the `Queue` are also cached on
`globalThis`, because Next.js re-evaluates server modules on every hot reload and a module-level
`let` would leak a connection pair per edit until Upstash started refusing them.

## The worker

`apps/worker` is a long-running Node process. There is no build step - `tsx src/index.ts` - which
matches the raw-TypeScript convention the workspace packages already follow and keeps `pnpm build`
in CI meaning exactly what it meant before. Because it has a `dev` script and turbo's `dev` task is
persistent, root `pnpm dev` starts the web app and the worker together.

Its configuration is parsed through Zod at startup and never read again; anything invalid exits
non-zero rather than booting. That is not ceremony. A worker running with a heartbeat interval
longer than its lease will have jobs reclaimed out from under it while it is perfectly healthy, and
the resulting duplicate execution presents as data corruption with nothing visibly broken. Making
that configuration impossible to start is far cheaper than making it possible to debug.

One run, end to end:

```text
message {jobId}
      │
      ▼
 claimJob ─── null ──▶ stand down (cancelled, finished, or someone else's)
      │ JobDetail
      ▼
 start heartbeat  ────────────────────────────┐  every 10s: renew lease,
 start deadline timer (maxDurationSeconds)    │  check fence, check cancel
      │                                       │
      ▼                                       │
 runPipeline: for each phase                  │
   transitionJob(from -> phase.status)  ◀─────┘  aborts the run on lease loss
   sleep(durationMs * speed)                     or a cancel request
   appendEvent(phase.completed)
      │
      ▼
 transitionJob(finalizing -> completed)
```

The shape to hold on to is that **BullMQ delivers a job id and nothing else**; every fact that
matters is a Postgres write guarded by the lease. A lost message, a duplicated message, or a message
for a job that finished ten minutes ago are all harmless, because the claim is what grants the right
to act and the claim is a compare-and-swap.

The pipeline itself is seven phases - provision, analyze, plan, implement, test, review, finalize.
Milestone 2 made provisioning and testing real sandbox work; analyzing, planning, implementing,
reviewing and finalizing remain simulated until later milestones. The five simulated phases total
about 15 seconds, which is still roughly the right length to watch a job cross the dashboard. That
is the entire reason `runPipeline` takes its clock, its sleep, its callbacks and its fault injector
as arguments rather than importing them: the same runner drives the demo at `speed: 1` and the unit
tests at `speed: 0`.

Seven fault-injection modes exist so the recovery machinery and the sandbox failure taxonomy have
something to recover from on demand: `throw` (retryable), `fatal` (terminal), `hang` (ignores the
job deadline), and `exit` (`process.exit(1)` mid-phase, which is `kill -9` on demand), plus
`no-daemon`, `oom`, and `slow-command` for sandbox-specific failures. They are configured by
`RIVET_FAULT_PHASE` and `RIVET_FAULT_MODE`, read in the worker and nowhere else. The
sandbox-specific modes wrap a provider for one attempt, so concurrent jobs do not share fault state.

### Two counters, and which one is true

`job.attemptsMade` is BullMQ's per-message retry count. `jobs.attempt_count` is how many times any
worker has claimed this job, including reclaims after a crash BullMQ never heard about. They
routinely disagree, both are logged, and **Postgres is the one that is true.** The sweeper's attempt
ceiling is checked against the Postgres counter for exactly that reason: a job that reliably kills
its worker would otherwise be reclaimed forever, taking a worker down each time.

### Failure handling

One `classify()` function feeds two systems that must not drift apart - Postgres needs a status and
a `failure_category`, BullMQ needs to know whether to retry - and the switch on its result is the
entire retry policy:

| Class           | Job row                                     | Message                         |
| --------------- | ------------------------------------------- | ------------------------------- |
| `retryable`     | back to `queued`, lease cleared             | rethrow; BullMQ applies backoff |
| `terminal`      | `failed` with a `failure_category`          | `UnrecoverableError`, no retry  |
| `timed_out`     | `timed_out`                                 | `UnrecoverableError`, no retry  |
| `cancelled`     | `cancelled` (a cancelled job is not failed) | completes normally              |
| `shutting_down` | back to `queued`, lease released            | put back via `moveToDelayed`    |
| `lease_lost`    | **nothing at all**                          | completes normally              |

The default is the important one: **an unrecognised error is terminal, not retryable.** Retrying an
error nobody has reasoned about is how one bug becomes three identical bugs, a tripled bill, and a
timeline three times as hard to read. Retryability is a claim about an error and has to be made
deliberately, by throwing `RetryableJobError`. On the final BullMQ delivery, a retryable error is
recorded as `failed` with the category it carries rather than being left in `queued` for the sweeper
to guess at later.

`lease_lost` writing nothing is the other one worth pausing on. If a worker discovers mid-run that
it no longer owns its job, another worker is already running it. Not a status, not an event, not
even a lease clear: every write from that point would land in the middle of someone else's run,
which is precisely the split-brain the lease exists to prevent. Walking away silently is the whole
correct behaviour.

## The lease and heartbeat protocol

This is where the reliability story actually lives, and the first question it has to answer is why
BullMQ's own locks and stalled-job detection are not enough. They are fine, and they are not the
same thing: **they describe a message, not a job.** A worker killed with `kill -9` mid-run never
tells Redis anything, and a message BullMQ eventually gives up on says nothing about how far the job
behind it got - which phase it reached, whether it already wrote a terminal status, whether some
other process is currently mid-write on the same row. So Rivet keeps the authoritative answer to
"who is running this job, and are they still alive" in the same database as the job itself:

- `lease_owner` - who holds it. Also the fencing token.
- `lease_expires_at` - until when.
- `heartbeat_at` - when they last said something. Observability; the lease is what enforces.

`claimJob` moves a `queued` job to `provisioning`, stamps all three, bumps `attempt_count`, and
coalesces `started_at` so a reclaimed job keeps its original start time and end-to-end duration
stays honest across a crash. It is one transition and therefore one compare-and-swap, so two workers
racing on the same job produce exactly one winner and one `null`. `null` is an ordinary answer, not
an error: cancelled before anyone got to it, already terminal, duplicate message, lost race.

**A lease that has run out on a non-terminal job means its holder is gone, whatever Redis
believes.** That single fact is what the sweeper acts on, and it is the reason the lease is worth
having on top of a queue that already has locks.

### Three concerns, one round trip

The heartbeat is the nicest detail in the milestone. Every ten seconds it issues one `UPDATE`, and
that statement does three jobs at once:

- **Liveness.** Pushing `lease_expires_at` forward is how a healthy worker tells the sweeper to
  leave its job alone.
- **Fencing.** The `WHERE lease_owner = ?` predicate means a worker whose job was reclaimed gets
  zero rows back, learns it has been fenced out, and aborts immediately.
- **Cancellation delivery.** `cancel_requested_at` comes back on the same row. Cancel needs no
  pub/sub channel and no poll of its own: the API stamps a column, and the worker notices within one
  interval.

Note what it deliberately does not do: it never touches `status`. A heartbeat is not a state change,
and `transitionJob` remains the only writer of that column.

**`heartbeat * 3 <= lease` is asserted at startup.** Three, so that one slow query and one dropped
packet are both survivable. Two makes a single hiccup fatal; ten means a genuinely dead worker holds
its job for minutes. The corollary is that a failed heartbeat is not a failed job - it is logged and
retried on the next interval, because the lease has two more intervals of slack by construction, and
if the database really has gone the lease lapses on its own and the sweeper does the right thing.
That is a better outcome than a worker killing a healthy job over one dropped connection.

### Transitions

Every status change goes through `transitionJob()`, which is the only writer of `jobs.status` - a
rule that is compile-enforced, since `TransitionInput["patch"]` is
`Omit<Partial<NewJob>, "status">`. It does four things in one transaction:

1. `SELECT ... FOR UPDATE` takes the row lock and reads the job as it really is, along with the
   database's own `now()`. The worker's clock is never trusted for lease arithmetic.
2. Checks the guard table: `ALLOWED_TRANSITIONS` is the full fourteen-state machine, and an edge it
   does not have throws before touching anything. The `-> queued` edge on every in-flight status is
   the reclaim path, which makes a sweeper putting an orphaned job back an ordinary legal transition
   rather than a special case that bypasses the guard.
3. Checks the preconditions on the locked row: the status is one the caller expected (the
   compare-and-swap), and the lease is still the caller's (the fence).
4. Writes the update and the `job_events` row together.

Reading and checking in TypeScript rather than cramming the predicates into one self-referential
`UPDATE` buys two things. The conflict error can say what the status actually was, which turns a
silent zero-row update into a diagnosable event. And the event row can record the one concrete
status the job moved away from, rather than the set the caller was willing to accept - a timeline
entry reading `from: ["testing", "reviewing", "revising"]` is not a fact about this job.

A conflict is not a bug and callers never retry harder; it means something else got there first, and
the correct response is always to stand down.

## The sweeper

Reconciliation, running every 60 seconds inside every worker. It exists because there are two leaks
between Postgres and Redis, they fail in opposite directions, and neither can be closed by being
more careful at the write site.

**Leak one: a job Postgres thinks is running, that nothing is running.** A `kill -9`, an OOM, a
container that disappeared. What is left is a row in a leased status whose `lease_expires_at` has
quietly passed. `reclaimExpiredJobs` scans for exactly that with `FOR UPDATE ... SKIP LOCKED`, and
decides one of three things per job, in priority order: honour a cancellation that was requested
while the dead worker was alive; fail the job with `failure_category: lease_expired` if it has
burned every attempt; otherwise clear the lease, transition it back to `queued`, write a
`job.reclaimed` event, and enqueue a fresh message.

`SKIP LOCKED` is a throughput property, not a correctness one, and it is worth being clear which is
which. The lock is taken and released by the scan alone; it is not held across the transitions,
because those need to enqueue afterwards and holding a Postgres transaction open across a Redis
round trip is a bad trade. Correctness comes from `transitionJob`'s compare-and-swap: if two
sweepers pick the same job, the second finds a status it did not expect and writes nothing.

There is one honest limit here, and it is specific to the `kill -9` case. The dead worker's message
is still sitting in Redis marked active, because nothing told Redis anything either, and the adapter
will not displace a message that is not finished - so the reclaim's enqueue answers `already-queued`
and produces no redelivery. The message genuinely still exists, so that is correct rather than a
gap, but it means recovery waits for BullMQ's stalled-job detection to move the message back to
`wait`. End-to-end crash recovery therefore takes the slower of the two mechanisms: Rivet's lease
expiry plus a sweep interval, or BullMQ's `lockDuration` plus `stalledInterval`. Both are on the
order of a minute, and neither half can be dropped - BullMQ's cannot see the job row, and Rivet's
cannot displace a live message.

**Leak two: a job Postgres thinks is queued, that no message points at.** This is the dual-write
gap, and it deserves its own section.

The sweep runs as a BullMQ job scheduler rather than a `setInterval`, for two reasons that are the
same reason: the schedule lives in Redis, so N workers still produce one sweep per interval rather
than N, and it survives a restart without any worker having to remember it held the timer. Every
worker upserts the same scheduler id at startup. 60 seconds and not 10, because a sweep is a
Postgres query on a schedule and Neon's compute endpoint will not autosuspend while something keeps
querying it - a chattier sweeper quietly spends the free tier's monthly compute allowance on finding
nothing.

## The dual-write gap, and why the sweeper is the honest answer

`POST /api/jobs` commits a row to Postgres and then sends a message to Redis. There is no
distributed transaction between the two, and the gap between them is real: if the process dies in
between, or Redis is unreachable, or Redis loses data, Postgres says `queued` and Redis has nothing.

Rivet's answer is not a two-phase commit, and it is not pretending the window does not exist. It is
this: **Postgres is the source of truth, so a `queued` row with no message is a recoverable state
rather than a lost job.** `requeueOrphanedJobs` finds rows that have been sitting in `queued` longer
than a sweep interval and enqueues them again. Re-adding with the job's own UUID as the message id
makes that safe to repeat, and safe to do redundantly - a row that did have a message answers
`already-queued` and nothing happens.

Three consequences follow, and they are the visible design of the system rather than incidental
details:

- **A failed enqueue is not a failed request.** `POST /api/jobs` returns `201` even when Redis is
  unreachable, because the job genuinely does exist. Returning `500` would be a lie the client could
  not act on, and it would tempt a retry that creates a second job. The failure is logged and
  written to the timeline as `job.enqueue_failed`, so the job's own history explains why nothing
  happened for a minute.
- **Flush Redis entirely and every outstanding job still runs**, one sweep interval later. That is
  the property that makes "Redis holds nothing that matters" a claim rather than a slogan.
- **It also catches a case that is not a leak at all**: a job BullMQ has stopped retrying. The
  processor releases a transiently failed job back to `queued` and rethrows so BullMQ applies its
  backoff; when BullMQ exhausts its own attempts it simply stops, leaving the row in `queued`. The
  sweeper is the backstop, and it works only because the adapter clears a finished message before
  reusing its id.

**A transactional outbox is the stronger answer, and it is deliberately not built.** Writing the
intent-to-enqueue into a table inside the job's own transaction and having a relay process drain it
would close the window rather than reconcile it. It costs a second table, a relay, and its own
failure modes, to buy correctness this design already gets from reconciliation, at the price of up
to one sweep interval of latency in a rare case. That trade is worth revisiting when the latency
matters or when a job has external side effects that must not be replayed - which is Milestone 6's
territory, not this one's.

## The event log

`job_events` is append-only. Nothing updates a row and nothing deletes one, apart from the cascade
when a job is deleted.

Two rules make it trustworthy. `appendEvent()` is the only writer, and it takes an `Executor` rather
than reaching for the pool - so `transitionJob` passes its transaction and the event lands
atomically with the status change it describes. The timeline can therefore never disagree with the
row it is describing, in either direction: no status change without its event, no event for a change
that rolled back. This is the concrete reason Milestone 0 chose `pg` over Neon's HTTP driver, which
has no interactive transactions.

The id is a `bigserial`, globally monotonic across all jobs rather than a per-job counter that would
need a lock to allocate. Ordering within a job is all that matters, and a single lease holder is the
only writer for a given job, so gaps and cross-job interleaving are harmless. Milestone 3 uses that
id directly as the SSE `Last-Event-ID`, which is why `GET /api/jobs/:id/events?after=<id>` already
has the cursor shape it will need.

Event types and failure categories are `text` columns validated by Zod, not `pgEnum`s. That is a
deliberate asymmetry with `job_status`, which does get a real Postgres enum and a type-level drift
assertion. Status is a closed state machine that is indexed, queried, and guarded; the event
vocabulary is a growing description of what happened, read back only to render a timeline, and it
churns every milestone. Paying a migration per new event type buys nothing.

Today the timeline is server-rendered on each request, with a client component calling
`router.refresh()` every two seconds while the job is non-terminal. It carries a `TODO(M3)` marker
and is deleted when the event stream lands. It exists because the alternative was a demo that needs
manual refreshing, and it is smaller than the Milestone 0 scaffolding it replaced.

## Database access

Rivet uses **`drizzle-orm/node-postgres` with a `pg` Pool**, not Neon's HTTP driver.

The HTTP driver is optimized for one-shot queries from edge runtimes and does not support
interactive transactions. `transitionJob` needs them - a lock, a read, a conditional update and an
event insert, all atomic - and the worker is a long-running Node process where a connection pool is
exactly the right shape. That was a bet made in Milestone 0 and it paid: the worker landed sharing
one driver and one `db` export with the web app, with no rewrite.

Two connection strings, for two different jobs:

- **`DATABASE_URL`** is Neon's pooled endpoint, through PgBouncer. All application queries go
  through it, which is what keeps connection counts sane across serverless invocations.
- **`DATABASE_URL_UNPOOLED`** is the direct endpoint. Migrations use it, because DDL through
  PgBouncer in transaction pooling mode is unreliable. The migration script falls back to
  `DATABASE_URL` when it is unset, which is how CI points migrations at an ephemeral branch with a
  single variable.

The consequence of the `pg` choice is that anything touching the database must run on the Node.js
runtime. That is the App Router default, so the rule is simply that `runtime = "edge"` never appears
in this codebase.

The Drizzle client is constructed lazily on first use, so importing `@rivet/database` never opens a
connection or throws. Typecheck, lint and unit-test runs have no `DATABASE_URL` and must not need
one. `@rivet/queue` obeys the identical rule for `REDIS_URL`, for the identical reason.

## Migrations

Migration SQL is generated by drizzle-kit from the schema and committed under
`packages/database/drizzle/`. It is applied by a small programmatic runner
(`packages/database/src/migrate.ts`) rather than by the drizzle-kit CLI, so that applying migrations
is one plain Node process with no dev-only tooling in its path - the same shape a deploy step wants.

Every pull request gets an ephemeral Neon branch and has the migrations applied to it before merge.
That catches the class of schema bug that only shows up on apply - a non-nullable column added to a
table with rows, an enum value used before it exists - against a real copy of the database rather
than a fresh empty container.

## How this is tested

Two suites, and the split is deliberate rather than administrative.

`pnpm test` runs with **no database and no Redis**, and that is a property worth protecting rather
than a limitation to work around. It is what proves the lazy clients stay lazy and that `pnpm build`
needs no environment, which is in turn what makes CI cheap and a fork's pull request able to pass.
It covers the guard table, the failure classification, the phase list against the guard table, the
pipeline runner at `speed: 0`, the config invariant, the in-memory queue and the job service.

`pnpm test:integration` runs 34 tests in about 15 seconds against real Postgres, real Redis and real
BullMQ workers - `postgres:17` and `redis:8` service containers in CI, local services on a dev
machine. It is a separate vitest config with no file pattern in common with the default suite, so
`pnpm test` cannot pick it up by accident. What it proves is the list of claims this document makes:
exclusive claim under a race, compare-and-swap rejection, heartbeat renewal and fencing, crash
recovery and sweeper reclaim, retry and terminal failure, timeout, cancellation in all four of its
states, idempotent enqueue, and the orphaned-`queued` reconciliation.

Two details in that suite are load-bearing. Time is **compressed, not faked**: a two-second lease
and a half-second heartbeat are real timings against a real database, with `pipelineSpeed: 0` so
that costs seconds rather than minutes. Fake timers cannot survive a round trip to Postgres, which
is where the clock that matters actually lives. And the suite refuses to run against any host that
is not plainly local, because every case truncates `jobs` and `job_events` while `.env.local` on
every dev machine points at the real Neon database.

## What is deliberately absent

Named so their absence reads as a decision rather than an oversight: no authentication or `user_id`
(Milestone 9 brings GitHub identity), no `repository_id` foreign key (there is no Repository table
to point at, so the job stores a plain `repo_url`), no event stream - the timeline is polled, not
pushed (M3), no model call of any kind (M4), no checkpoints or resumable jobs (M6), no transactional
outbox (see the dual-write section for why), and no deployment: both processes run locally, because
Milestone 2's Docker sandboxes will constrain the worker's host anyway and deploying twice is wasted
work.

The one piece of scaffolding left in the codebase is `apps/web/components/job-status-poller.tsx`, a
client component calling `router.refresh()` every two seconds while a job is non-terminal. It exists
because the detail page is server-rendered and nothing else asks for an update, so without it the
demo needs manual refreshing. It carries a `TODO(M3)` marker and is deleted when SSE lands.

Milestone 1's simulation knobs now have a narrower job: phase durations and `RIVET_PIPELINE_SPEED`
remain for the five phases that are still simulated, while the fault modes also exercise real
sandbox failure categories. The `simulated_failure` category is gone. Everything around them -
claiming, leasing, heartbeating, transitioning, retrying, cancelling, recovering - is designed to
survive the real phase bodies unchanged, which is the actual deliverable of the milestone.
