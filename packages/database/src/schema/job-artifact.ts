import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { jobs } from "./job";

/**
 * The durable output of a job: the diff it produced, the stats of that diff, the
 * summary the session ended on.
 *
 * Append-only, like `job_events` and `job_commands`, and for the same reason:
 * this is evidence that a run happened, and evidence that can be edited is not
 * evidence. Nothing updates a row.
 *
 * PRD §8 asks for S3-compatible object storage and PRD §10.8 gives `Artifact` a
 * `storage_url`, and both are right for the end state. They are wrong for
 * Milestone 5, where a fourth local service would have to be absent from CI's
 * `verify` job, present in two of the other three, and credentialed in the
 * worker, all to store a diff that is usually under 20KB. `content` is bounded
 * the same way a command transcript is, and the day object storage arrives it is
 * an adapter behind `PhaseContext.artifact()` rather than an edit to five phases.
 */
export const jobArtifacts = pgTable(
  "job_artifacts",
  {
    /** Globally monotonic, same reasoning as `job_events.id`, and the list cursor. */
    id: bigserial("id", { mode: "number" }).primaryKey(),

    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),

    /**
     * See `ARTIFACT_TYPES` in `@rivet/contracts`.
     *
     * Text rather than a pgEnum, following `job_events.type` rather than
     * `jobs.status`: the vocabulary grows every milestone - a plan in M6,
     * validation reports in M7, review reports in M8 - and it is never queried
     * as a state machine, so a migration per new entry buys nothing.
     */
    type: text("type").notNull(),

    /**
     * The `JobStatus` the job was in when the artifact was produced.
     *
     * Text for the same reason `job_commands.phase` is: it records what a phase
     * did, it is never joined as a state machine, and a phase whose meaning
     * moves in a later milestone should not invalidate the history of runs that
     * used the old one.
     */
    phase: text("phase").notNull(),

    /** Capped head+tail, with the elided byte count stated inline. Never null; an empty artifact wrote "". */
    content: text("content").notNull(),

    /**
     * The true byte size before truncation.
     *
     * Recorded rather than derived from `content`, because the whole value of
     * the column is in the case where the two disagree: a 4MB diff stored as
     * 256KB is a fact worth being able to read off the row.
     */
    byteSize: integer("byte_size").notNull(),

    /** True when the cap was hit, so a reader knows the gap in the middle is ours. */
    truncated: boolean("truncated").notNull().default(false),

    /** Type-specific structure: the parsed `--numstat` totals on a `diff_stat`, for instance. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The only read pattern: one job's artifacts in order, optionally after a cursor.
  (table) => [index("job_artifacts_job_id_id_idx").on(table.jobId, table.id)],
);

export type JobArtifactRow = typeof jobArtifacts.$inferSelect;
export type NewJobArtifactRow = typeof jobArtifacts.$inferInsert;
