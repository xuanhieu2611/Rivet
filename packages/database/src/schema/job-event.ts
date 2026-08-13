import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { jobs } from "./job";

/**
 * Append-only history of everything that happened to a job.
 *
 * Every status change writes one of these in the same transaction as the update
 * itself, so the timeline can never disagree with the row it describes. That
 * atomicity is the reason Milestone 0 chose the `pg` driver over Neon's HTTP
 * driver, which has no interactive transactions.
 *
 * Nothing is ever updated or deleted here. Milestone 3 streams the same rows
 * over SSE; the table is shaped for that already.
 */
export const jobEvents = pgTable(
  "job_events",
  {
    /**
     * Globally monotonic. Ordering *within* a job is what matters, and a single
     * lease holder is the only writer for a given job, so gaps and cross-job
     * interleaving are harmless. Milestone 3's SSE reconnect uses this directly
     * as `Last-Event-ID`, which is why it is a bigserial and not a per-job
     * counter that would need a lock to allocate.
     */
    id: bigserial("id", { mode: "number" }).primaryKey(),

    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),

    /**
     * See `JOB_EVENT_TYPES` in `@rivet/contracts`.
     *
     * Text rather than a pgEnum for the same reason as `jobs.failure_category`:
     * the vocabulary grows with every milestone and is not queried as a state
     * machine, so a migration per new event type would be pure overhead.
     */
    type: text("type").notNull(),

    /** One human-readable line. This is what the timeline renders. */
    message: text("message").notNull(),

    /**
     * Structured payload: `{ from, to }`, `{ phase, durationMs }`, `{ error }`.
     *
     * Typed loosely here and precisely as `JobEventData` in `@rivet/contracts`.
     * The dependency runs contracts -> database and must not be made circular,
     * so this package deliberately does not know the payload vocabulary.
     */
    data: jsonb("data").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The only read pattern: one job's events in order, optionally after a cursor.
  (table) => [index("job_events_job_id_id_idx").on(table.jobId, table.id)],
);

export type JobEventRow = typeof jobEvents.$inferSelect;
export type NewJobEventRow = typeof jobEvents.$inferInsert;
