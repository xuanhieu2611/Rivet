import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The full job lifecycle from PRD §10.3, defined in one place.
 *
 * Postgres enum values are cheap to append but awkward to reorder or remove, so
 * every status a later milestone transitions through is declared now even
 * though Milestone 0 only ever writes `queued`.
 */
export const JOB_STATUSES = [
  "queued",
  "provisioning",
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "revising",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
  "budget_exceeded",
  "timed_out",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);

/**
 * Milestone 0 subset of the Job table.
 *
 * Columns whose values only exist once execution is real (`base_commit_sha`,
 * `started_at`, `completed_at`, `final_branch`, `pull_request_url`,
 * `failure_reason`) are nullable now so Milestone 1 fills them in without a
 * migration. `user_id` and `repository_id` are omitted entirely - there is no
 * User or Repository table to point a foreign key at yet.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    title: text("title").notNull(),
    description: text("description").notNull(),

    repoUrl: text("repo_url").notNull(),
    baseBranch: text("base_branch").notNull().default("main"),
    baseCommitSha: text("base_commit_sha"),

    status: jobStatusEnum("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),

    maxDurationSeconds: integer("max_duration_seconds").notNull().default(3600),
    maxCostUsd: numeric("max_cost_usd", { precision: 10, scale: 2 }).notNull().default("5.00"),
    maxModelCalls: integer("max_model_calls").notNull().default(200),
    maxToolCalls: integer("max_tool_calls").notNull().default(500),

    // --- agent usage (M4 and M6) ----------------------------------------
    // These are cumulative job totals, including usage persisted before an
    // attempt is interrupted. The phase writes them under the worker lease.
    totalInputTokens: integer("total_input_tokens").notNull().default(0),
    totalOutputTokens: integer("total_output_tokens").notNull().default(0),
    totalCostUsd: numeric("total_cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
    totalModelCalls: integer("total_model_calls").notNull().default(0),
    totalToolCalls: integer("total_tool_calls").notNull().default(0),
    totalTurns: integer("total_turns").notNull().default(0),

    // --- independent review (M8) -----------------------------------------
    /**
     * Whether this job gets an independent review session at all.
     *
     * A property of the job rather than of the worker, so a job that recorded
     * `independent` is reviewed whichever worker picks it up - the same property
     * `max_cost_usd` has. Text rather than a pgEnum for the same reason
     * `failure_category` is: Zod in `@rivet/contracts` is the validation.
     */
    reviewMode: text("review_mode").notNull().default("independent"),
    /**
     * How many revisions this job may spend before a blocking verdict fails it.
     *
     * The review loop is a budget, and budgets are the job's rather than the
     * attempt's, so both the bound and the counter below live on the row: a
     * worker killed during the second revision must not come back and get two
     * more loops.
     */
    maxReviewLoops: integer("max_review_loops").notNull().default(2),
    /** Revisions this job has already spent. Never reset by a reclaim. */
    reviewLoops: integer("review_loops").notNull().default(0),
    /** The last verdict, so counting outcomes needs no event-log replay. */
    reviewDecision: text("review_decision"),
    /** Blocking findings in that last verdict. Null until one exists. */
    reviewBlockingCount: integer("review_blocking_count"),

    // --- dispatch and deadline (M6) -------------------------------------
    /** Monotonically identifies a durable delivery generation for this job. */
    dispatchGeneration: integer("dispatch_generation").notNull().default(0),
    /** Set on the first claim and retained across every recovery attempt. */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),

    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),

    finalBranch: text("final_branch"),
    pullRequestUrl: text("pull_request_url"),
    failureReason: text("failure_reason"),

    // --- worker lease (PRD §16) ------------------------------------------
    // Postgres is the source of truth for who owns a job; Redis only delivers
    // the message. These three columns are what make that true.
    /** Worker that currently owns this job. Null when nothing holds it. */
    leaseOwner: text("lease_owner"),
    /** Lease deadline. Past due with a non-terminal status means orphaned. */
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Last heartbeat, for observability. The lease is what enforces anything. */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),

    // --- retry accounting -------------------------------------------------
    /**
     * Incremented on every claim, including reclaims after a crash.
     *
     * Distinct from BullMQ's `attemptsMade`, which only counts retries of a
     * message it knows about. A worker killed with `kill -9` never reports
     * back, so this counter is the one that is true.
     */
    attemptCount: integer("attempt_count").notNull().default(0),

    // --- cancellation -----------------------------------------------------
    /**
     * Set by the API. The worker notices on its next heartbeat and aborts
     * between phases, so cancellation needs no pub/sub channel of its own.
     */
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),

    // --- failure detail (PRD §23) ----------------------------------------
    /**
     * Machine-readable category from `FAILURE_CATEGORIES` in `@rivet/contracts`.
     *
     * Text rather than a pgEnum on purpose: unlike `status`, this is not a
     * closed state machine and the taxonomy churns every milestone. Zod
     * validates it; a new category costs nothing.
     */
    failureCategory: text("failure_category"),

    // --- sandbox execution (PRD §15, M2) ---------------------------------
    /**
     * The container currently running this job, null when none exists.
     *
     * Written by `recordProvisioning()`, which is why Milestone 2 added a
     * fourth `.update(jobs)` site. It cannot touch `status` - the patch type is
     * the same `Omit<Partial<NewJob>, "status">` every other writer takes.
     *
     * Not the reaper's handle: a crashed worker may never have written it. The
     * `rivet.job-id` container label is what survives `kill -9`.
     */
    sandboxId: text("sandbox_id"),
    /**
     * What the run actually executed in: image digest, node version, package
     * manager and version, lockfile hash, resolved commit, resource limits.
     *
     * PRD §11 B asks for it; §24.2 (reproducibility) is what will eventually
     * read it back.
     */
    envFingerprint: jsonb("env_fingerprint").$type<Record<string, unknown>>(),
  },
  (table) => [
    // Dashboard list query: filter by status, newest first.
    index("jobs_status_created_at_idx").on(table.status, table.createdAt.desc()),
    // The sweeper's hot query: everything whose lease has run out. A partial
    // index excluding terminal statuses would be tighter, but that needs a
    // fourteen-value NOT IN inside `.where()` for a table this small. Revisit
    // if the sweeper ever shows up in a slow query log.
    index("jobs_lease_expires_at_idx").on(table.leaseExpiresAt),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
