# Architecture

This document describes Rivet **as it exists today**, at the end of Milestone 4, and names the
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
queue, the worker, and everything that makes a job survive the worker dying. Milestone 2 built the
Docker sandbox and made provisioning and baseline testing real. Milestone 3 made the append-only
event log observable through a resumable SSE stream, live status, timeline, and command log.
Milestone 4 added the Pi adapter and made `implementing` real: Pi runs in the trusted worker while
its four tools operate inside the job's sandbox. Milestone 5 moved the baseline to `analyzing`,
where it runs before anything is edited, and made `planning` say plainly that it produced nothing.
Validation, review, and finalization remain simulated until the rest of Milestone 5 and Milestone 8.

## What exists today

| Component     | Where                | Responsibility                                                          |
| ------------- | -------------------- | ----------------------------------------------------------------------- |
| Web UI        | `apps/web/app`       | Dashboard, new-job form, job detail with live status, timeline and logs |
| HTTP API      | `apps/web/app/api`   | `GET`/`POST /api/jobs`, `GET /api/jobs/:id`, `/events`, `/cancel`       |
| Worker        | `apps/worker`        | BullMQ consumer: claim, heartbeat, run the pipeline, finalize, sweep    |
| Domain logic  | `packages/core`      | Jobs, transitions, claims, cancellation, the event log, the pipeline    |
| Queue adapter | `packages/queue`     | BullMQ over Redis behind core's `JobQueue` port, plus an in-memory fake |
| Sandbox       | `packages/sandbox`   | Dockerode behind core's `SandboxProvider` port, plus a scripted fake    |
| Coding agent  | `packages/agent`     | Pi adapter, scripted fake, event mapper, and sandbox-backed tools       |
| Contracts     | `packages/contracts` | Zod schemas, job/event/command contracts, and the status enum           |
| Data access   | `packages/database`  | Drizzle schema, generated migrations, the `pg` pool                     |
| Shared config | `packages/config`    | The tsconfig and ESLint bases every workspace extends                   |

Four tables. `jobs` holds the domain model: the task, repository and base branch, the full status
machine, budget ceilings, lease and retry state, and the sandbox's resolved commit and environment
fingerprint. `job_events` is the append-only history behind the execution timeline. `job_commands`
is the append-only command ledger; transcripts live there rather than bloating every timeline read.
`job_artifacts` is the append-only store of a run's durable output - the diff, its stats, the
implementation summary - bounded and read one fetch away for the same reason. Columns that only
later milestones can fill remain nullable.

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
no `bullmq`, `ioredis` or `dockerode`, because domain logic that depends on an adapter cannot claim
to be independent of it. Core declares `JobQueue` and `SandboxProvider` ports; `packages/queue` and
`packages/sandbox` are the only packages that know Redis and Docker exist. And core reads no
`process.env`: configuration arrives as arguments, which is what lets the pipeline run at `speed: 0`
in unit tests, in under a millisecond, with no fake timers.

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
`GET /api/jobs/:id/events?after=<id>` is the timeline's incremental read. Content negotiation keeps
ordinary callers on the JSON cursor envelope while `Accept: text/event-stream` opens the live SSE
tailer. The durable event id is the reconnect cursor, so the transport changes without changing the
underlying contract.

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

## The sandbox

The sandbox follows the same port/adapter split as the queue. `packages/core` declares the
`SandboxProvider`, `Sandbox`, request, result and resource-limit types, while `packages/sandbox`
implements them with dockerode and supplies a scripted fake. Core can orchestrate provisioning and
the baseline without importing Docker, and importing the adapter does not contact the daemon. The
client, image check and network are all lazy. That preserves the important property that unit tests
and builds need no Docker daemon.

A real attempt gets one long-lived container. It runs as uid 1000 with all Linux capabilities
dropped, `no-new-privileges`, memory and swap set to the same ceiling, CPU and PID limits, and the
user-defined `rivet-sandbox` bridge. Provisioning clones into `/home/node/workspace/repo`, resolves
HEAD, installs from the detected lockfile, and records the image, tool versions, lockfile hash,
commit and limits as an environment fingerprint. `analyzing` then runs the repository's own `test`
script in the same filesystem, before any phase has changed a file. Every command is an argv array
rather than a shell string, and stdout and stderr are captured separately. Output above the cap
keeps its head and tail with an explicit byte-count marker in the middle.

The processor owns the container handle, not the phase that creates it. Its `finally` destroys the
container after completion, failure, cancellation, job timeout, lease loss and graceful shutdown.
That ownership matters because the processor deliberately abandons a phase promise that ignores an
abort. A command timeout or abort kills the whole disposable container because Docker exposes no
reliable way to kill an exec by itself. `destroy()` is idempotent and never masks the error that led
to cleanup.

`kill -9` skips every `finally`, so the sweeper also runs a sandbox reaper. This is the third
reconciliation loop: the lease reconciles Postgres with workers, orphan re-enqueueing reconciles
Postgres with Redis, and the reaper reconciles Postgres with Docker. Containers carry job, worker
and creation-time labels. After a grace period, the reaper removes one unless Postgres says its job
has a live, unexpired lease.

Sandbox failures are explicit. Daemon outages and container-create failures are retryable host
problems. An unavailable repository, unsupported project and dependency-install failure are terminal
repository problems. Command timeout and OOM are terminal limit failures, with OOM read from
Docker's state rather than guessed from exit code 137. A non-zero command exit is not itself an
exception: provisioning interprets it as failure, while a red baseline records `failed` and lets the
job continue.

### The coding-agent boundary

The worker holds the Pi session and the provider credential. The session's host working directory is
an empty, per-job scratch directory, so Pi cannot discover a developer's `~/.pi` configuration or a
repository on the worker filesystem. The repository is visible only through four custom tool
operations:

```text
Pi session on worker
  read / write / edit / bash
              │
              ▼
        AgentToolbox
       ┌──────┴──────┐
       │             │
  getFile/putFile  ctx.exec
       │             │
       └──────┬──────┘
              ▼
       job's Docker container
```

Pi's schemas and descriptions remain Pi's. Rivet replaces only the operations underneath them, and
asserts after session construction that the active tool names are exactly `bash`, `edit`, `read`,
and `write`. Pi's `bash` operation receives an environment assembled from the worker process; Rivet
intentionally ignores it and passes no worker environment to the sandbox. This is what keeps
`OPENROUTER_API_KEY` out of arbitrary repository processes.

This contains the **model**, not the **harness**. Pi itself still runs as the worker user in the
trusted process and has no general permission system. A future hardened deployment must protect the
worker process too; the M4 boundary proves that repository code cannot use the provider key through
the sandbox and that an accidentally enabled Pi built-in tool fails the active-tool assertion.

## The worker

`apps/worker` is a long-running Node process. There is no build step - `tsx src/index.ts` - which
matches the raw-TypeScript convention the workspace packages already follow and keeps `pnpm build`
in CI meaning exactly what it meant before. Because it has a `dev` script and turbo's `dev` task is
persistent, root `pnpm dev` starts the web app and the worker together.

Its configuration is parsed through Zod at startup and never read again; anything invalid exits
non-zero rather than booting. That is not ceremony. A worker running with a heartbeat interval
longer than its lease will have jobs reclaimed out from under it while it is perfectly healthy, and
the resulting duplicate execution presents as data corruption with nothing visibly broken. Making
that configuration impossible to start is far cheaper than making it possible to debug. The same
startup boundary refuses `RIVET_AGENT=pi` without its OpenRouter key and refuses `RIVET_AGENT=off`
in production, so a worker cannot silently claim that a simulated implementing phase did real work.

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
   real body or sleep(durationMs * speed)        timeout or a cancel request
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
Milestone 2 made provisioning and the baseline real sandbox work, Milestone 4 made implementing a
real Pi session when an agent is supplied, and Milestone 5 moved the baseline onto `analyzing` so it
measures the repository before the session edits it. Planning now runs a body that records one
`plan.deferred` event and returns, rather than sleeping for two seconds as though a plan were being
made; testing, reviewing and finalizing are still simulated. Those three sleeps total about 9
seconds, which is still roughly the right length to watch a job cross the dashboard. The
`RIVET_AGENT=off` integration configuration deliberately leaves implementing simulated as well, so
lifecycle tests need no model key. That is the entire reason `runPipeline` takes its clock, its
sleep, its callbacks and its fault injector as arguments rather than importing them: the same runner
drives the demo at `speed: 1` and the unit tests at `speed: 0`.

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
only writer for a given job, so gaps and cross-job interleaving are harmless. M3 uses that id
directly as the SSE `Last-Event-ID` and the `id` field in every persisted event frame.

Event types and failure categories are `text` columns validated by Zod, not `pgEnum`s. That is a
deliberate asymmetry with `job_status`, which does get a real Postgres enum and a type-level drift
assertion. Status is a closed state machine that is indexed, queried, and guarded; the event
vocabulary is a growing description of what happened, read back only to render a timeline, and it
churns every milestone. Paying a migration per new event type buys nothing.

### The live event path

The event stream is a database tailer, not a broker and not a second history.
`GET /api/jobs/:id/events` preserves the JSON `{ events, cursor }` response for ordinary callers.
When the request accepts `text/event-stream`, the same route first validates the job and cursor,
then opens a Node.js Web Streams response with `retry: 2000`, connection and keepalive comments, and
one `job.event` data frame per durable row. `X-Accel-Buffering: no`,
`Cache-Control: no-cache, no-transform`, and the Node runtime keep proxies from treating it like a
buffered finite response.

The first cursor is the maximum valid `?after=` query value and `Last-Event-ID` header. That closes
the gap between the server-rendered snapshot and the first connection, and it makes native
EventSource reconnect safe even when it reuses the original URL. The tailer reads at most 200 rows
in ascending id order, drains full pages immediately, then polls once per second. It borrows a
pooled Postgres connection for each query and never holds a connection for the life of the response.
A database error breaks the response without changing job status; EventSource reconnects from the
last delivered id.

The browser reducer treats delivery as at least once: it stores events by durable id, sorts them,
and ignores duplicates. The provider closes the stream while the tab is hidden and reconnects from
its latest cursor when visible. When a terminal transition is observed, the server waits through a
short quiescence window so `sandbox.destroyed` can arrive, sends a non-persisted `stream.end` frame,
and closes. The client performs one final `router.refresh()` for fields that are not event
consumers.

Command rows remain append-only. `command.started` creates a running UI row with a
`commandExecutionId`; `command.completed` or `command.failed` pairs the lifecycle events, while the
durable command row and bounded stdout/stderr transcript are fetched only when needed. M3 does not
stream output bytes.

M4 adds coarse agent rows to the same log: session start, turn start, completed assistant message,
tool start and completion, one usage row per turn, budget breach, and session end. Pi token deltas
are never persisted. A shell tool's lifecycle still goes through `PhaseContext.exec`, so its command
row and `command.*` events are the same durable facts as a command Rivet ran during provisioning or
the baseline. The `jobs` row keeps cumulative input tokens, output tokens, and priced cost, updated
after each usage event under the current lease.

## The artifact store

`job_artifacts` holds a run's durable output - the diff it produced, the parsed stats of that diff,
the summary its session ended on - and follows the event log's two rules for the same reasons.
`recordArtifact()` in `packages/core/src/artifacts/` is the only writer, nothing updates or deletes
a row, and it takes an `Executor`, so `PhaseContext.artifact()` can write the row and its
`artifact.recorded` event in one transaction. An event carrying an `artifactId` that resolves to
nothing would be worse than no event at all, which is the same argument `exec` already makes for
`job_commands`.

Content is bounded by the writer rather than by its callers, with the head+tail elision a command
transcript gets, and the cap is `RIVET_ARTIFACT_MAX_BYTES` on the worker rather than a constant in
core - `packages/core` holds no policy. `byte_size` records the size of what arrived rather than the
size of what was stored, which is the whole reason it is a column: a 4MB diff kept as 256KB is a
fact a reader should get off the row without fetching either version, and `truncated` says the gap
in the middle is Rivet's.

Reads are split. `listArtifacts()` returns metadata without content, because the page that renders
the timeline should not pull a diff into every render; `getArtifact()` returns one artifact's
content and is scoped by `jobId`, since ids are globally monotonic and an unscoped fetch would let
one job's URL read another job's diff.

PRD §8 asks for S3-compatible object storage and PRD §10.8 gives `Artifact` a `storage_url`. Both
are right for the end state and wrong for Milestone 5, where a fourth local service would have to be
absent from CI's `verify` job, present in two of the other three, and credentialed in the worker,
all to store a diff that is usually under 20KB. When it arrives it replaces the bodies of
`recordArtifact` and `getArtifact` behind the same signatures, because phases reach the store only
through `PhaseContext.artifact()`.

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

Four suites, and the split is deliberate rather than administrative.

`pnpm test` runs with **no database and no Redis**, and that is a property worth protecting rather
than a limitation to work around. It is what proves the lazy clients stay lazy and that `pnpm build`
needs no environment, which is in turn what makes CI cheap and a fork's pull request able to pass.
It covers the guard table, the failure classification, the phase list against the guard table, the
pipeline runner at `speed: 0`, the config invariant, the in-memory queue and the job service.

`pnpm test:integration` runs against real Postgres, real Redis and real BullMQ workers -
`postgres:17` and `redis:8` service containers in CI, local services on a dev machine. It is a
separate vitest config with no file pattern in common with the default suite, so `pnpm test` cannot
pick it up by accident. It proves exclusive claims, fencing, retries, cancellation, timeouts, crash
recovery, Postgres/Redis reconciliation, and the implementing phase with a scripted coding agent.

`pnpm test:sandbox` is the third, non-overlapping suite. It uses the real Docker daemon plus local
Postgres and Redis. It proves stream separation, non-zero exits, truncation, command timeouts,
memory and PID limits, uid 1000, cleanup and reaping, drives a hermetic repository through the real
worker to `completed`, and exercises the four sandbox-backed coding-agent tools without a model. Its
git daemon serves temporary bare repositories only; no public network or package registry is
involved. The suite refuses a non-local Docker host unless the caller explicitly opts in, just as
the integration suite refuses remote databases.

`pnpm test:streaming` is the fourth suite, in `apps/web/tests/streaming`. It uses real Postgres but
no Redis or Docker and calls the route handler directly with `Request` objects. It proves SSE
framing, historical replay, live append delivery, reconnect cursor precedence, duplicate-safe client
reduction, two independent viewers, abort cleanup, terminal grace, already-terminal close, JSON
compatibility, and invalid input handling. It runs in its own CI job because it truncates `jobs` and
`job_events` just like the worker integration suite. It reads `.env.test`, refuses non-local
databases by default, and uses `RIVET_ALLOW_REMOTE_INTEGRATION=1` only as a deliberate escape hatch.

Two details in the infrastructure suites are load-bearing. Time is **compressed, not faked**: a
two-second lease and a half-second heartbeat are real timings against a real database, with
`pipelineSpeed: 0` so that costs seconds rather than minutes. Fake timers cannot survive a round
trip to Postgres, which is where the clock that matters actually lives. And every suite refuses to
run against a host that is not plainly local, because its cases truncate `jobs` and `job_events`
while `.env.local` on every dev machine points at the real Neon database.

## What is deliberately absent

Named so their absence reads as a decision rather than an oversight: no authentication or `user_id`
(Milestone 9 brings GitHub identity), no `repository_id` foreign key (there is no Repository table
to point at, so the job stores a plain `repo_url`), no completion detection or diff persistence
(M5), no checkpoints or resumable jobs (M6), no transactional outbox (see the dual-write section for
why), and no deployment. The Pi implementation session is real and analysis establishes a baseline,
but validation, review and finalization are still simulated and planning deliberately produces
nothing, and the bridge network is not the hardened isolation boundary a production worker needs.

The stream targets a long-lived Node.js host. Native EventSource reconnect makes interruptions safe,
but a deployment platform that buffers or caps long responses can still terminate it. Before public
deployment, Rivet needs a streaming-capable host or a dedicated event gateway. That hosting decision
must not move event authority out of Postgres.

Milestone 1's simulation knobs now have a narrower job: phase durations and `RIVET_PIPELINE_SPEED`
remain for the four phases that are still simulated, while the fault modes also exercise real
sandbox and coding-agent failure categories. The `simulated_failure` category is gone. Everything
around them - claiming, leasing, heartbeating, transitioning, retrying, cancelling, recovering - is
designed to survive the real phase bodies unchanged, which is the actual deliverable of the
milestone.
