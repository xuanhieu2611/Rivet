# Milestone 1 - Background job execution

**Status:** planned, not started. **Predecessor:** Milestone 0 (job model, API, dashboard) is
complete. **PRD reference:** §31 Milestone 1, §16 Queue and worker reliability, §10.3-10.4 domain
model, §23 failure handling.

**Demo checkpoint from the PRD:** create job -> queue -> worker -> complete. No AI yet.

**The real goal:** the thing being built in this milestone is not "a worker that sleeps for 20
seconds". It is the durable execution substrate that every later milestone plugs into. When
Milestone 4 drops a Pi session into the middle of this pipeline, nothing about claiming, leasing,
heartbeating, transitioning, retrying, cancelling, or recovering should have to change. The
simulated phases are scaffolding; the machinery around them is the deliverable.

---

## 1. Decisions

These were settled before planning. Rationale is recorded here because most of them are the answer
to an interview question in PRD §39.

| Decision       | Choice                                                                                             | Why                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue          | BullMQ on Redis                                                                                    | PRD's suggestion. Mature TS API, built-in backoff, delayed jobs, stalled detection, job schedulers. A second datastore is worth explaining. |
| Redis host     | Upstash, for both development and production                                                       | No local container to manage. See §11 for the cost caveat, which is real.                                                                   |
| Topology       | `apps/web` + `apps/worker`, sharing `packages/core`                                                | Two deployables, one copy of the domain logic. `apps/api` is deferred until an HTTP boundary actually buys something.                       |
| Worker payload | Simulated phase pipeline with fault injection                                                      | Exercises retries, lease expiry, cancellation, and crash recovery for real, with no sandbox and no model.                                   |
| Crash recovery | Postgres lease + heartbeat + sweeper, on top of BullMQ                                             | Postgres is the source of truth for job state; Redis is only a delivery mechanism. The sweeper reconciles the two.                          |
| Event history  | Append-only `job_events` table now, SSE in M3                                                      | "Persist job transitions" is an M1 checkbox, and the event write belongs in the same transaction as the status write.                       |
| Testing        | Unit tests in the existing no-DB job, plus a new CI job with Postgres and Redis service containers | Keeps `verify` fast and always green, while proving the queue and the transition logic actually work together.                              |
| Deployment     | Local only                                                                                         | M2's Docker sandboxes will constrain the worker's host anyway. Deploying twice is wasted work.                                              |

### Assumptions made without asking

Flagged so they are easy to overrule:

1. **`POST /api/jobs/:id/cancel` lands in M1.** It is in PRD §19, and cancellation is the cheapest
   way to prove cooperative abort works while the pipeline is still fake.
2. **Package name is `@rivet/core`.** It will hold more than jobs eventually (budgets, checkpoints,
   validation orchestration), so `@rivet/jobs` would be wrong within two milestones. Mitigation
   against it becoming a dumping ground: enforced subdirectories, see §5.
3. **Event types and failure categories are `text` columns validated by Zod, not `pgEnum`.** The
   status enum is a closed state machine that is indexed and queried on, so it earns a real Postgres
   enum plus the drift assertion. The failure taxonomy in PRD §23 has thirteen entries today and
   will churn every milestone; paying a migration per new category is not worth it.
4. **A dev-only status refresh replaces the dev-only advance button.** Without SSE (M3) the job page
   would need manual refreshing to see anything move, which ruins the demo checkpoint. It is a small
   client component and smaller than the scaffolding it replaces.
5. **The worker uses the pooled `DATABASE_URL`** with a small pool (`max: 5`), same as the web app.

---

## 2. Definition of done

Copied from the PRD checkboxes, expanded into things that can actually be verified.

- [ ] Redis is configured, and both the web app and the worker connect to it lazily.
- [ ] `POST /api/jobs` persists the row and enqueues it; the response is still `201` with the job.
- [ ] A worker process claims the job, walks it through the simulated pipeline, and marks it
      `completed`. The dashboard reflects each transition without a manual refresh.
- [ ] Every status change is persisted with an accompanying `job_events` row, written in the same
      transaction.
- [ ] Illegal transitions are rejected by a guard table, and a stale-status update is rejected by a
      compare-and-swap, both with tests.
- [ ] A transient failure is retried with backoff; a terminal failure is not retried. The
      distinction is a classification function with unit tests, and the outcome is persisted as
      `failure_category`.
- [ ] The worker heartbeats while a job is in flight. If the heartbeat stops, the lease expires and
      a sweeper reclaims the job.
- [ ] `kill -9` on the worker mid-job, then starting a new worker, results in the job completing.
      This is an automated integration test, not just a manual demo.
- [ ] Two workers cannot run the same job. Proven by a concurrent-claim test.
- [ ] `POST /api/jobs/:id/cancel` stops an in-flight job cooperatively and lands it in `cancelled`.
- [ ] A job whose `maxDurationSeconds` elapses lands in `timed_out`.
- [ ] Enqueueing the same job twice results in one execution.
- [ ] All Milestone 0 scaffolding (`PATCH /api/jobs/:id`, `nextStatus`, `HAPPY_PATH_SEQUENCE`,
      `AdvanceStatusControl`) is deleted.
- [ ] `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check` all pass with no
      database and no Redis, exactly as today.
- [ ] `pnpm test:integration` passes against real Postgres and Redis, and runs in CI as its own job.
- [ ] `docs/architecture.md`, `AGENTS.md`, and `README.md` describe the system as it now is.

---

## 3. Target shape after M1

```text
   browser
      │
      │  page nav / fetch
      ▼
   apps/web (Next.js)                            apps/worker (Node, long-running)
      │                                                │
      │  createJob()                                   │  Worker("job-runs")
      │  enqueue(jobId)                                │  claim -> heartbeat -> phases
      │                                                │  sweeper (job scheduler)
      ▼                                                ▼
   ┌───────────────────────────────────────────────────────────────┐
   │ packages/core   domain logic, zero framework and zero bullmq   │
   │   jobs/         create, list, get, transitions, claims         │
   │   events/       append-only job_events                         │
   │   pipeline/     phase definitions, the simulated runner        │
   │   queue/        the JobQueue PORT (an interface, no impl)      │
   └───────────────────────────────────────────────────────────────┘
      │                                                │
      │                                                │
      ▼                                                ▼
   packages/database (Drizzle, pg Pool)          packages/queue (BullMQ adapter
      │                                           + in-memory fake for tests)
      ▼                                                ▼
   Neon Postgres  ◀── source of truth            Upstash Redis ── delivery only
```

The load-bearing idea in that diagram: **Postgres holds job state, Redis holds nothing that
matters.** If Redis is flushed, no job is lost. The sweeper finds every row that Postgres says
should be moving but is not, and re-enqueues it. That is the property that makes the whole thing
durable, and it is worth being able to say out loud.

`packages/core` importing `bullmq` would break it, because then the domain logic would depend on
delivery. Hence the port/adapter split: core defines `JobQueue`, `packages/queue` implements it with
BullMQ and again with an in-memory array for tests. It is the same boundary shape the PRD asks for
around Pi in §8, applied one milestone earlier.

---

## 4. Data model changes

One migration. Generate it with `pnpm db:generate` after editing the schema, commit the SQL, then
`pnpm db:migrate`.

### 4.1 New columns on `jobs`

```ts
// packages/database/src/schema/job.ts

  // --- worker lease (PRD §16) -------------------------------------------
  /** Worker that currently owns this job. Null when nothing holds it. */
  leaseOwner: text("lease_owner"),
  /** Lease deadline. Past-due with a non-terminal status means orphaned. */
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  /** Last heartbeat, for observability. The lease is what enforces anything. */
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),

  // --- retry accounting --------------------------------------------------
  /** Incremented on every claim, including reclaims after a crash. */
  attemptCount: integer("attempt_count").notNull().default(0),

  // --- cancellation ------------------------------------------------------
  /** Set by the API. The worker notices between phases and aborts. */
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),

  // --- failure detail (PRD §23) ------------------------------------------
  /** Machine-readable category. Validated by Zod, not by a pgEnum - see §1. */
  failureCategory: text("failure_category"),
```

New index, for the sweeper's hot query:

```ts
index("jobs_lease_expires_at_idx").on(table.leaseExpiresAt),
```

A partial index would be tighter (`where status not in (terminal...)`), but Drizzle's `.where()` on
indexes plus a fourteen-value NOT IN is more machinery than a table of this size needs. Revisit if
the sweeper ever shows up in a slow query log.

### 4.2 New table `job_events`

```ts
// packages/database/src/schema/job-event.ts

export const jobEvents = pgTable(
  "job_events",
  {
    /**
     * Globally monotonic. Ordering within a job is what matters, and a single
     * lease holder is the only writer for a given job, so gaps and cross-job
     * interleaving are harmless. M3's SSE reconnect uses this directly as
     * `Last-Event-ID`, which is why it is a bigserial and not a per-job counter.
     */
    id: bigserial("id", { mode: "number" }).primaryKey(),

    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),

    /** See JOB_EVENT_TYPES in @rivet/contracts. Text on purpose - the vocabulary grows. */
    type: text("type").notNull(),

    /** One human-readable line. This is what the timeline renders. */
    message: text("message").notNull(),

    /** Structured payload: { from, to }, { phase, durationMs }, { error }, etc. */
    data: jsonb("data").$type<JobEventData>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("job_events_job_id_id_idx").on(table.jobId, table.id)],
);
```

`onDelete: "cascade"` is deliberate: events have no meaning without their job, and nothing else
points at them.

### 4.3 Contracts

```ts
// packages/contracts/src/job-event.ts

export const JOB_EVENT_TYPES = [
  "job.created",
  "job.enqueued",
  "job.claimed",
  "job.status_changed",
  "phase.started",
  "phase.completed",
  "job.cancel_requested",
  "job.retry_scheduled",
  "job.reclaimed", // sweeper took it back from a dead worker
  "job.lease_lost", // worker discovered it no longer owns the job
  "job.failed",
  "job.completed",
] as const;

export const FAILURE_CATEGORIES = [
  "worker_crash",
  "lease_expired",
  "simulated_failure", // M1 only, from the fault injector
  "timed_out",
  "budget_exceeded",
  "cancelled",
  "unknown",
] as const;
```

Both get Zod schemas. `JobDetail` gains `attemptCount`, `failureCategory`, `cancelRequestedAt`, and
`leaseExpiresAt`; a new `JobEvent` interface is exported for the timeline.

Do **not** add the lease columns to `JobSummary`. The dashboard does not need them, and keeping the
list payload narrow matters more once there are hundreds of jobs.

---

## 5. `packages/core`

The extraction AGENTS.md says M1 triggers.

```text
packages/core/
  src/
    index.ts
    jobs/
      job-service.ts     create / list / get, moved verbatim from apps/web
      transitions.ts     the guard table + transitionJob()
      claims.ts          claim / heartbeat / release / reclaim
      failure.ts         error classes + classify()
      budget.ts          isBudgetExceeded(), timeout math
    events/
      event-service.ts   appendEvent(), listEvents()
    pipeline/
      phases.ts          the phase table
      run-pipeline.ts    the runner, fully injectable
    queue/
      job-queue.ts       the PORT: interface JobQueue { ... }
    index.ts
```

**Invariants for this package**, to be added to AGENTS.md:

- No `next/*` imports. Same rule as the M0 service layer, same reason.
- No `bullmq` or `ioredis` imports. Core defines the queue interface; it never constructs one.
- No `process.env` reads. Configuration arrives as arguments. This is what makes the pipeline
  testable with zero-millisecond phases.
- Every file lives under one of the four subdirectories. `src/util.ts` at the top level is the first
  sign this package is turning into a junk drawer.

### 5.1 The transition guard

```ts
// packages/core/src/jobs/transitions.ts

/**
 * Legal state transitions. Anything absent throws before touching the database.
 *
 * M1 only walks the simulated path, but the table is written for the whole
 * lifecycle so later milestones add behaviour, not structure.
 */
export const ALLOWED_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["provisioning", "cancelled", "failed"],
  provisioning: ["analyzing", "failed", "cancelled", "timed_out", "queued"],
  analyzing: ["planning", "failed", "cancelled", "timed_out", "queued"],
  planning: ["implementing", "failed", "cancelled", "timed_out", "queued"],
  implementing: ["testing", "failed", "cancelled", "timed_out", "budget_exceeded", "queued"],
  testing: ["reviewing", "implementing", "failed", "cancelled", "timed_out", "queued"],
  reviewing: ["revising", "finalizing", "failed", "cancelled", "timed_out", "queued"],
  revising: ["testing", "failed", "cancelled", "timed_out", "budget_exceeded", "queued"],
  finalizing: ["completed", "failed", "cancelled", "timed_out", "queued"],
  completed: [],
  failed: [],
  cancelled: [],
  budget_exceeded: [],
  timed_out: [],
};
```

The `-> queued` edge on every in-flight status is the reclaim path: a sweeper putting an orphaned
job back on the queue is a legal transition, not a special case that bypasses the guard.

### 5.2 The transition itself

Two things must be true of every status change: it is atomic with its event row, and it cannot
clobber a change someone else made. Both fall out of one function.

```ts
export interface TransitionInput {
  jobId: string;
  /** Expected current status. The compare-and-swap half. */
  from: JobStatus | readonly JobStatus[];
  to: JobStatus;
  /** When present, the update also requires the caller to still hold the lease. */
  leaseOwner?: string;
  message: string;
  data?: JobEventData;
  /** Extra columns to set in the same statement (completedAt, failureReason, ...). */
  patch?: Partial<typeof jobs.$inferInsert>;
}

export async function transitionJob(
  input: TransitionInput,
  database: Database = db,
): Promise<JobDetail> {
  assertTransitionAllowed(input.from, input.to); // throws IllegalTransitionError

  return database.transaction(async (tx) => {
    const [row] = await tx
      .update(jobs)
      .set({ status: input.to, ...input.patch })
      .where(
        and(
          eq(jobs.id, input.jobId),
          inArray(jobs.status, asArray(input.from)),
          input.leaseOwner ? eq(jobs.leaseOwner, input.leaseOwner) : undefined,
        ),
      )
      .returning();

    // Zero rows means someone else moved this job first: a cancel landed, the
    // sweeper reclaimed it, or a second worker is running that should not be.
    if (!row) throw new TransitionConflictError(input);

    await tx.insert(jobEvents).values({
      jobId: input.jobId,
      type: "job.status_changed",
      message: input.message,
      data: { ...input.data, from: input.from, to: input.to },
    });

    return toJobDetail(row);
  });
}
```

This is the single reason M0 chose `pg` over Neon's HTTP driver, and it is worth pointing at when
someone asks why. Interactive transactions are needed here and the HTTP driver does not have them.

**Rule for AGENTS.md: nothing outside `transitions.ts` writes `jobs.status`.** The dev `PATCH`
endpoint being deleted in this milestone is what makes that rule enforceable.

### 5.3 Claim, heartbeat, release

```ts
/**
 * Atomically take ownership. One statement, so two workers racing on the same
 * job id produce exactly one winner and one `null`.
 */
export async function claimJob(
  jobId: string,
  leaseOwner: string,
  leaseSeconds: number,
): Promise<JobDetail | null> {
  const [row] = await db
    .update(jobs)
    .set({
      status: "provisioning",
      leaseOwner,
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
      heartbeatAt: sql`now()`,
      attemptCount: sql`${jobs.attemptCount} + 1`,
      startedAt: sql`coalesce(${jobs.startedAt}, now())`,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, "queued"),
        or(isNull(jobs.leaseExpiresAt), lt(jobs.leaseExpiresAt, sql`now()`)),
      ),
    )
    .returning();

  return row ? toJobDetail(row) : null;
}
```

Note `startedAt: coalesce(startedAt, now())` - a reclaimed job keeps its original start time, so
end-to-end duration stays honest across a crash.

The heartbeat is where three concerns collapse into one round trip, which is the nicest detail in
this milestone:

```ts
/**
 * Renews the lease and reports back. Returns null when the lease was lost,
 * which is the fencing check: if another worker reclaimed this job, the
 * `leaseOwner` predicate fails and this worker must abort immediately.
 */
export async function heartbeat(
  jobId: string,
  leaseOwner: string,
  leaseSeconds: number,
): Promise<{ cancelRequested: boolean; status: JobStatus } | null> {
  const [row] = await db
    .update(jobs)
    .set({
      heartbeatAt: sql`now()`,
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
    })
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, leaseOwner)))
    .returning({ cancelRequestedAt: jobs.cancelRequestedAt, status: jobs.status });

  if (!row) return null;
  return { cancelRequested: row.cancelRequestedAt !== null, status: row.status };
}
```

Liveness signal, fencing token check, and cancellation delivery, in one statement every ten seconds.
No pub/sub needed for cancel, no separate poll.

**Invariant: `heartbeatSeconds * 3 <= leaseSeconds`.** Defaults 10 and 30. Assert it in config
parsing so a bad env var fails at startup rather than causing jobs to be stolen out from under a
healthy worker. This deserves a unit test of its own.

### 5.4 The sweeper

```ts
/**
 * Finds jobs Postgres believes are running but whose worker has gone silent,
 * and puts them back on the queue.
 *
 * SKIP LOCKED so that two sweepers running concurrently divide the work instead
 * of blocking on each other.
 */
export async function reclaimExpiredJobs(
  queue: JobQueue,
  options: { maxAttempts: number; limit: number },
): Promise<ReclaimResult[]> {
  const orphaned = await db
    .select({ id: jobs.id, attemptCount: jobs.attemptCount, status: jobs.status })
    .from(jobs)
    .where(
      and(
        notInArray(jobs.status, [...TERMINAL_STATUSES]),
        ne(jobs.status, "queued"),
        lt(jobs.leaseExpiresAt, sql`now()`),
      ),
    )
    .limit(options.limit)
    .for("update", { skipLocked: true });

  // For each: attempts remaining -> transition to `queued`, clear the lease,
  // append a `job.reclaimed` event, re-enqueue. Otherwise -> `failed` with
  // failureCategory `lease_expired`.
}
```

The sweeper also handles the reverse leak: rows sitting in `queued` for longer than a threshold with
no Redis job behind them, which happens if the enqueue call failed after the insert committed, or if
Redis lost data. Re-adding with the job's UUID as the BullMQ job id makes that idempotent.

That dual-write gap between "row inserted" and "message enqueued" is worth naming explicitly,
because it is a question a good interviewer asks. The honest answer for M1: there is no distributed
transaction, the insert commits first, and the sweeper is the reconciliation loop that makes the
window survivable. A transactional outbox is the stronger answer and is deliberately not built yet.

### 5.5 The pipeline

```ts
// packages/core/src/pipeline/phases.ts

export interface Phase {
  status: JobStatus;
  label: string;
  /** Simulated work. Milestone 2 replaces this with sandbox calls. */
  durationMs: number;
}

export const SIMULATED_PIPELINE: readonly Phase[] = [
  { status: "provisioning", label: "Provision sandbox", durationMs: 2_000 },
  { status: "analyzing", label: "Analyze repository", durationMs: 3_000 },
  { status: "planning", label: "Create plan", durationMs: 2_000 },
  { status: "implementing", label: "Implement change", durationMs: 5_000 },
  { status: "testing", label: "Run tests", durationMs: 4_000 },
  { status: "reviewing", label: "Review patch", durationMs: 3_000 },
  { status: "finalizing", label: "Finalize", durationMs: 2_000 },
];
```

Roughly 21 seconds end to end, which is about right for watching it happen.

The runner takes everything it needs as arguments. No env reads, no imports of the clock:

```ts
export interface PipelineDeps {
  phases: readonly Phase[];
  signal: AbortSignal; // cancellation and timeout both arrive here
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  onPhaseStart: (phase: Phase) => Promise<void>;
  onPhaseComplete: (phase: Phase, elapsedMs: number) => Promise<void>;
  /** Fault injection. Returns an error to throw at the start of a phase. */
  fault?: (phase: Phase) => Error | undefined;
  /** Scales every duration. Tests pass 0. */
  speed: number;
}
```

Tests drive the entire pipeline in under a millisecond with `speed: 0`, and the demo runs at
`speed: 1`. No `vi.useFakeTimers` gymnastics, no sleeping in CI.

Fault injection modes, driven by worker env vars for manual demos and by the `fault` callback in
tests:

- `throw` - a retryable error at a chosen phase, proving backoff and retry.
- `fatal` - a non-retryable error, proving the job fails without retrying.
- `hang` - ignore the abort signal, proving the timeout path.
- `exit` - `process.exit(1)` mid-phase, proving lease expiry and sweeper reclaim. This is the M6
  demo, available a milestone early.

---

## 6. `packages/queue`

Small package. Its whole job is to keep BullMQ out of `packages/core`.

```text
packages/queue/
  src/
    index.ts
    connection.ts     lazily-created ioredis client, memoized
    bull-queue.ts     BullQueue implements JobQueue
    memory-queue.ts   InMemoryQueue implements JobQueue, for unit tests
    names.ts          queue names in one place
```

### 6.1 Connection

Must obey the same rule as the database client: **importing this package never opens a connection
and never throws.** `next build` runs with no `REDIS_URL`.

```ts
// packages/queue/src/connection.ts
import IORedis, { type Redis } from "ioredis";

let client: Redis | undefined;

export function getRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set. Copy .env.example to .env.local.");

  client ??= new IORedis(url, {
    // BullMQ throws unless this is null on any connection a Worker uses.
    maxRetriesPerRequest: null,
    // Upstash is TLS. `rediss://` handles it, this is belt and braces.
    ...(url.startsWith("rediss://") ? { tls: {} } : {}),
  });
  return client;
}
```

There is a second trap specific to Next.js: dev-mode module re-evaluation creates a new client on
every hot reload and leaks connections until Upstash refuses them. Cache on `globalThis` in
development, the same pattern people use for Prisma clients:

```ts
const globalForRedis = globalThis as unknown as { __rivetRedis?: Redis };
client ??= globalForRedis.__rivetRedis ?? new IORedis(...);
if (process.env.NODE_ENV !== "production") globalForRedis.__rivetRedis = client;
```

### 6.2 Queue options tuned for Upstash

```ts
export function createJobQueue(): JobQueue {
  const queue = new Queue(QUEUE_NAMES.jobRuns, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      // Keep a small window for debugging; do not accumulate forever.
      removeOnComplete: { age: 3_600, count: 100 },
      removeOnFail: { age: 86_400, count: 500 },
    },
  });
  ...
}
```

Worker side:

```ts
new Worker(QUEUE_NAMES.jobRuns, processor, {
  connection: getRedis(),
  concurrency: config.workerConcurrency, // 2
  // Upstash bills per command and BullMQ polls when idle. Each blocking pop
  // waits this long before re-issuing, so a larger value costs almost nothing
  // in latency (a queued job wakes the blocking call immediately) and cuts the
  // idle command rate by 6x versus the 5s default.
  drainDelay: 30,
  lockDuration: 60_000,
  stalledInterval: 30_000,
  maxStalledCount: 2,
});
```

Enqueue is idempotent because the BullMQ job id is the job's UUID:

```ts
await queue.add("run-job", { jobId }, { jobId });
```

### 6.3 The in-memory fake

`InMemoryQueue` records `add` calls and lets a test drain them synchronously. This is what keeps the
web app's unit tests in the no-database CI job: `createJob` can be tested with a fake queue and a
mocked service, with nothing running.

**BullMQ v6 note.** v6 shipped 2026-07-30 and removed the legacy repeatable-jobs API entirely
(`repeat` on `queue.add`, `getRepeatableJobs`, `removeRepeatable`). The sweeper must use the **Job
Schedulers** API (`upsertJobScheduler`). Most tutorials online are v5 and will not work.
`Queue#client` and `Worker#blockingClient` are gone too, and `job.discard()` is replaced by throwing
`UnrecoverableError`. Pin the exact version in `package.json` and read the v6 docs, not blog posts.

v6 also added a Postgres queue backend. Not using it, but it is the escape hatch if Upstash's
per-command billing turns out to be annoying, and it is a good thing to know exists.

---

## 7. `apps/worker`

```text
apps/worker/
  src/
    index.ts        entrypoint: config, logger, wiring, shutdown
    config.ts       Zod-parsed env, fails loudly at startup
    logger.ts       pino, with a jobId child logger per run
    processor.ts    the BullMQ processor: claim -> run -> finalize
    heartbeat.ts    the interval loop and its abort wiring
    sweeper.ts      the scheduled reclaim job
    identity.ts     workerId
  package.json
  vitest.config.ts
  eslint.config.js
  tsconfig.json
```

Scripts: `"dev": "tsx watch src/index.ts"`, `"start": "tsx src/index.ts"`. **No `build` script.**
Consistent with the raw-TypeScript workspace convention, and it keeps `pnpm build` in CI unchanged.

Because `apps/worker` has a `dev` script and turbo's `dev` task is `persistent`, root `pnpm dev`
starts the web app and the worker together. That is the whole local demo in one command.

### 7.1 The processor

```ts
async function processJob(job: Job<{ jobId: string }>): Promise<void> {
  const { jobId } = job.data;
  const log = logger.child({ jobId, attempt: job.attemptsMade + 1 });

  const claimed = await claimJob(jobId, workerId, config.leaseSeconds);
  if (!claimed) {
    // Cancelled, already terminal, or held by a live lease. Not an error.
    log.info("skipping: job not claimable");
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(TIMEOUT), claimed.maxDurationSeconds * 1000);
  const stopHeartbeat = startHeartbeat({ jobId, controller, log });

  try {
    await runPipeline({ ...deps, signal: controller.signal });
    await transitionJob({ jobId, from: "finalizing", to: "completed", leaseOwner: workerId, ... });
  } catch (error) {
    await handleFailure(error, { jobId, job, log });   // see below
  } finally {
    clearTimeout(timeout);
    await stopHeartbeat();
  }
}
```

### 7.2 Failure handling

One classification function, unit tested, feeding two different systems:

```ts
export type FailureClass = "retryable" | "terminal" | "cancelled" | "timed_out" | "lease_lost";

export function classify(error: unknown): FailureClass;
```

- `retryable` -> transition back to `queued`, append `job.retry_scheduled`, rethrow so BullMQ
  applies its backoff and retries. On the final attempt BullMQ stops; the sweeper is the backstop.
- `terminal` -> transition to `failed` with a `failureCategory`, then throw `UnrecoverableError` so
  BullMQ does not retry. (v6: `UnrecoverableError`, not `job.discard()`.)
- `cancelled` -> transition to `cancelled`, return normally. A cancelled job is not a failed job.
- `timed_out` -> transition to `timed_out`, do not retry.
- `lease_lost` -> log and return **without touching the job row at all.** Something else owns it
  now. Writing anything here is exactly the split-brain bug the lease exists to prevent.

Two counters exist and they mean different things: `job.attemptsMade` is BullMQ's per-message retry
count, `jobs.attempt_count` is how many times any worker has claimed this job, including sweeper
reclaims after a crash that BullMQ never learned about. Log both. Postgres is the one that is true.

### 7.3 Graceful shutdown

On `SIGTERM`/`SIGINT`:

1. Stop accepting new jobs (`worker.close()`, which waits for in-flight jobs up to a grace period).
2. Stop the heartbeat.
3. **Release the lease**, do not fail the job: set `status = 'queued'`, `leaseOwner = null`,
   `leaseExpiresAt = null`, append `job.reclaimed`, re-enqueue. A deploy or a Ctrl-C should hand
   work back immediately rather than making the next worker wait 30 seconds for a lease to expire.
4. Close the Redis client and the pg pool.
5. Force-exit after a hard deadline (say 15s) so a wedged job cannot block a deploy forever.

`kill -9` skips all of this. That is the point: it is the case the sweeper exists for, and the
integration test that proves it.

### 7.4 The sweeper

Runs inside the worker process as a BullMQ job scheduler, so multiple workers do not each need their
own timer and the schedule survives restarts:

```ts
await queue.upsertJobScheduler("sweep-expired-leases", { every: 60_000 }, { name: "sweep" });
```

Every worker processes `sweep` jobs; `SKIP LOCKED` in the reclaim query means concurrent sweeps
divide the work. 60 seconds, not 10, for the Neon reason in §11.

---

## 8. `apps/web` changes

### 8.1 Enqueue on create

```ts
// app/api/jobs/route.ts  (POST)
const job = await createJob(parsed.data);
await getJobQueue().enqueueJobRun(job.id); // idempotent: bullmq jobId = job.id
return NextResponse.json(job, { status: 201, headers: { Location: `/api/jobs/${job.id}` } });
```

If the enqueue throws, **still return 201.** The job is durably persisted and the sweeper will pick
it up within a minute. Failing the request would be a lie: the job does exist. Log the enqueue
failure at `error` and append a `job.created` event noting the enqueue did not land.

### 8.2 New endpoints

- `POST /api/jobs/:id/cancel` - if `queued`, transition straight to `cancelled` and remove the
  BullMQ job. If in flight, stamp `cancelRequestedAt` and return `202`; the worker's next heartbeat
  sees it. If already terminal, return `409` with the current status. Idempotent: cancelling a
  cancelling job is a no-op `202`.
- `GET /api/jobs/:id/events` - the event list, `?after=<id>` for incremental fetch. M3 turns this
  into the SSE endpoint; building the cursor now means M3 changes the transport, not the contract.

### 8.3 UI

- **Execution timeline** on the job detail page, rendered from `job_events`. This is the first real
  version of PRD §18.4's left column. Static server-rendered list for now.
- **Attempt count, failure category, and duration** on the detail page.
- **Cancel button** for non-terminal jobs.
- **Temporary status refresh**, a client component that calls `router.refresh()` every 2 seconds
  while the status is non-terminal and stops at a terminal status. It keeps the M1 demo observable
  until M3 replaces it with SSE. Roughly 25 lines, and without it the demo checkpoint requires
  manual refreshing.

### 8.4 Deletions

- `PATCH /api/jobs/:id` handler and its `patchJobSchema`.
- `nextStatus()`, `HAPPY_PATH_SEQUENCE` from `lib/job-status.ts`, and their tests.
- `components/advance-status-control.tsx` and its use in `app/jobs/[id]/page.tsx`.
- `updateJobStatus()` from the service layer. Replaced by `transitionJob`, which is the only writer.
- Move `apps/web/lib/services/job-service.ts` and its test into `packages/core`; update the four or
  five import sites.

Grep for `TODO(M1)` at the end and confirm zero hits.

---

## 9. Configuration

Additions to `.env.example` and to the worker's Zod config schema:

```bash
# Upstash Redis. `rediss://` (two s) is TLS, which Upstash requires.
# BullMQ polls Redis even when idle; Upstash bills per command, so their docs
# recommend a Fixed plan over pay-as-you-go for this workload.
REDIS_URL="rediss://default:PASSWORD@fitting-mammal-12345.upstash.io:6379"

# Worker tuning. HEARTBEAT * 3 <= LEASE is asserted at startup.
WORKER_CONCURRENCY="2"
WORKER_LEASE_SECONDS="30"
WORKER_HEARTBEAT_SECONDS="10"
WORKER_SWEEP_INTERVAL_MS="60000"
WORKER_MAX_ATTEMPTS="3"

# M1 simulation knobs. Deleted when the sandbox lands in M2.
RIVET_PIPELINE_SPEED="1"           # 0 = instant, for tests
RIVET_FAULT_PHASE=""               # e.g. "testing"
RIVET_FAULT_MODE=""                # throw | fatal | hang | exit

LOG_LEVEL="info"
```

The worker parses all of it through Zod at startup and exits non-zero on anything invalid. A worker
that boots with a 90-second heartbeat and a 30-second lease will corrupt job state in a way that is
miserable to debug; make it impossible to start.

---

## 10. Testing

### 10.1 Unit, in the existing no-database CI job

| Area              | Cases                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transitions.ts`  | every legal edge accepted; a sample of illegal ones rejected; terminal statuses have no outgoing edges; every `JobStatus` key is present (guards against a new status being added without an edge) |
| `failure.ts`      | each error type maps to the right `FailureClass`; unknown errors are terminal, not retryable                                                                                                       |
| `phases.ts`       | phase statuses form a legal path through `ALLOWED_TRANSITIONS`; no duplicates; ordering                                                                                                            |
| `run-pipeline.ts` | runs all phases in order at `speed: 0`; aborts mid-phase on signal; fault callback surfaces                                                                                                        |
| `config.ts`       | heartbeat/lease invariant rejected; bad numbers rejected; defaults applied                                                                                                                         |
| `memory-queue.ts` | dedupes by job id; records payloads                                                                                                                                                                |
| `job-service`     | existing M0 tests, moved                                                                                                                                                                           |
| `event-service`   | event payload shaping                                                                                                                                                                              |

### 10.2 Integration, in a new CI job with service containers

Files named `*.int.test.ts`, excluded from the default `test` script, run by `test:integration`. A
vitest `globalSetup` runs `pnpm db:migrate` against the container and truncates between tests. Each
test file uses a unique queue name so runs cannot interfere.

The list, which is also the definition-of-done checklist made executable:

1. **Happy path.** Create via the service, enqueue, run a real `Worker`, assert final status
   `completed`, assert the event sequence matches the pipeline exactly.
2. **Exclusive claim.** Two `claimJob` calls in parallel for one job: exactly one returns a row.
3. **Compare-and-swap.** `transitionJob` with a stale `from` throws `TransitionConflictError` and
   writes no event.
4. **Heartbeat renews.** Lease deadline moves forward; job survives past the original expiry.
5. **Crash recovery.** Start the pipeline, kill the heartbeat and abandon the job without releasing
   (simulating `kill -9`), wait for the lease to expire, run the sweeper, assert the job returns to
   `queued` with `attempt_count` incremented and a `job.reclaimed` event, then let a second worker
   finish it. **This is the marquee test.**
6. **Fencing.** After a sweeper reclaims a job, the original worker's next `transitionJob` with its
   stale `leaseOwner` fails rather than corrupting state.
7. **Retryable failure.** Fault at `testing` with `throw`: job returns to `queued`, retries, and
   completes. `attempt_count` is 2.
8. **Terminal failure.** Fault with `fatal`: job is `failed`, `failure_category` persisted, BullMQ
   does not retry.
9. **Timeout.** `maxDurationSeconds` shorter than the pipeline, `hang` fault: job lands `timed_out`.
10. **Cancellation.** Cancel mid-flight: job lands `cancelled` within one heartbeat interval and no
    further phase events are appended.
11. **Idempotent enqueue.** Enqueue the same id twice: one execution, one set of events.
12. **Orphaned queued row.** Insert a job row without enqueueing, run the sweeper, assert it gets
    enqueued and completes. This is the dual-write reconciliation.

Use short lease and heartbeat values (2s / 500ms) and `RIVET_PIPELINE_SPEED=0` so the whole suite
runs in seconds rather than minutes.

### 10.3 CI

`verify` stays exactly as it is: no database, no Redis, fast, and it still proves `pnpm build` works
with no environment at all. Add a second, parallel job:

```yaml
integration:
  name: Integration
  runs-on: ubuntu-latest
  services:
    postgres:
      image: postgres:17 # match Neon's major version
      env: { POSTGRES_PASSWORD: postgres, POSTGRES_DB: rivet_test }
      options: >-
        --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
      ports: ["5432:5432"]
    redis:
      image: redis:8
      options: >-
        --health-cmd "redis-cli ping" --health-interval 10s --health-timeout 5s --health-retries 5
      ports: ["6379:6379"]
  env:
    DATABASE_URL: postgresql://postgres:postgres@localhost:5432/rivet_test
    REDIS_URL: redis://localhost:6379
  steps: [checkout, pnpm, node, install, "pnpm db:migrate", "pnpm test:integration"]
```

CI uses plain Redis rather than Upstash. The protocol is identical, secrets do not have to reach
fork PRs, and tests do not consume the Upstash quota.

---

## 11. Risks

**Upstash billing.** BullMQ polls continuously; a worker left running overnight on pay-as-you-go
generates commands the whole time. Mitigations, in order: use a Fixed plan (Upstash's own
recommendation for BullMQ), set `drainDelay: 30`, keep the sweep interval at 60s, and stop the
worker when not actively developing. Worth watching the Upstash console during the first week.

**Neon compute hours.** A sweeper querying every 60 seconds keeps the Neon compute endpoint awake
permanently, defeating autosuspend. On the free tier that burns the monthly compute allowance for
nothing. Same mitigation: stop the worker when not developing. If it becomes a real problem, gate
the sweep on the queue having been non-empty recently.

**Upstash connection limits.** A `Worker` needs a blocking connection plus a regular one, the
`Queue` needs one, and the web app in dev leaks one per hot reload without the `globalThis` cache.
Budget around five to six and check the plan's ceiling.

**BullMQ v6 is new.** Released 2026-07-30 with real breaking changes (see §6.3). Search results and
LLM training data mostly describe v5. Pin the version and check the v6 changelog when an API does
not exist.

**ioredis 6.** BullMQ 6 declares `ioredis >=5.0.0` as an optional peer. ioredis 6.0.0 should satisfy
it, but if pnpm warns or something misbehaves at runtime, pin ioredis to 5.x. Verify at install
time, not at debug time.

**Scope creep into M2.** The temptation will be to make the worker do something real, like actually
cloning the repository. Resist it. The pipeline is a placeholder with a stable interface; M2
replaces the phase bodies and touches nothing else. That is the whole reason the runner takes its
callbacks as arguments.

---

## 12. Pull request sequence

Sized so each one is reviewable and leaves `main` green.

| #   | Title                               | Contents                                                                                                                                            | Est. |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | Extract `packages/core`             | Move `job-service.ts` and its tests out of `apps/web`, add the package scaffolding, update imports. Zero behaviour change.                          | 1-2h |
| 2   | Lease, event, and retry schema      | Schema edits, generated migration, contracts (`JobEvent`, event types, failure categories), `transitions.ts` + guard table + tests.                 | 3-4h |
| 3   | `packages/queue`                    | The `JobQueue` port in core, the BullMQ adapter, the in-memory fake, the lazy connection. Web enqueues on create. No worker yet.                    | 2-3h |
| 4   | `apps/worker`                       | Config, logger, identity, claim, heartbeat, pipeline runner, processor, graceful shutdown. Root `pnpm dev` runs both apps.                          | 4-6h |
| 5   | Delete M0 scaffolding, add timeline | Remove `PATCH`, `nextStatus`, `AdvanceStatusControl`. Add the events timeline, attempt count, temporary status refresh, `GET /api/jobs/:id/events`. | 2-3h |
| 6   | Failures, retries, timeout, cancel  | `classify()`, retry/terminal paths, `UnrecoverableError`, timeout via `AbortSignal`, `POST /api/jobs/:id/cancel`, cancel button.                    | 3-4h |
| 7   | Sweeper and crash recovery          | `reclaimExpiredJobs`, the job scheduler, the orphaned-`queued` reconciliation, fault injection modes.                                               | 2-3h |
| 8   | Integration tests and CI            | `*.int.test.ts` convention, vitest global setup, all twelve tests from §10.2, the new CI job.                                                       | 4-5h |
| 9   | Docs                                | `docs/architecture.md` rewrite of the affected sections, `AGENTS.md` invariants and commands, `README.md`.                                          | 1-2h |

Roughly 22 to 32 hours. PRs 1 through 4 are the spine; if time runs short, 7 and 8 are what make the
milestone worth having, not 5.

---

## 13. Documentation to update at the end

**`AGENTS.md`:**

- Current state: Milestone 1 complete, jobs execute, the pipeline is simulated.
- New invariants: `packages/core` has no `next/*`, no `bullmq`, no `ioredis`, no `process.env`;
  nothing outside `transitions.ts` writes `jobs.status`; the queue connection is lazy for the same
  reason the database client is; `heartbeat * 3 <= lease`; event types and failure categories are
  Zod-validated text, and why they are not pgEnums.
- Commands: `pnpm test:integration`, and the note that `pnpm dev` now starts two processes.
- Replace the temporary status-refresh entry with the M3 SSE lifecycle and reconnect invariants.

**`docs/architecture.md`:** new sections for the queue, the worker, the lease and heartbeat
protocol, the sweeper, and the event log. Update "what is deliberately absent" - M1 is no longer in
that list, and the `apps/api` extraction trigger needs revisiting now that it was resolved with a
shared package instead.

**`README.md`:** local setup now needs `REDIS_URL`, and the demo is "create a job and watch it run".
