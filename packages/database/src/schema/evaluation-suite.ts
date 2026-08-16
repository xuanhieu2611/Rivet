import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A persisted evaluation matrix.
 *
 * The arms and case ids are JSON snapshots rather than joins because a suite
 * must continue to describe the matrix it started with even when the runner's
 * configuration or benchmark directory changes later.
 */
export const evaluationSuites = pgTable("evaluation_suites", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  arms: jsonb("arms").$type<Record<string, unknown>[]>().notNull(),
  repetitions: integer("repetitions").notNull().default(3),
  caseIds: jsonb("case_ids").$type<string[]>().notNull(),
  /** Text keeps this vocabulary independent from the job state machine. */
  status: text("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EvaluationSuiteRow = typeof evaluationSuites.$inferSelect;
export type NewEvaluationSuiteRow = typeof evaluationSuites.$inferInsert;
