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
     * Written by `recordProvisioning()`, which is why this milestone adds a
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
