import {
  index,
  integer,
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
  },
  (table) => [
    // Dashboard list query: filter by status, newest first.
    index("jobs_status_created_at_idx").on(table.status, table.createdAt.desc()),
  ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
