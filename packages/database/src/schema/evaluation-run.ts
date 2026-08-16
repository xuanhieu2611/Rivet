import {
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { jobs } from "./job";
import { benchmarkCases } from "./benchmark-case";
import { evaluationSuites } from "./evaluation-suite";

/**
 * One case, arm and repetition in an evaluation suite.
 *
 * The row is the immutable result snapshot. The unique matrix key prevents a
 * retrying runner from recording two answers for the same cell, while the
 * nullable job reference still lets a failed job creation be represented.
 */
export const evaluationRuns = pgTable(
  "evaluation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    suiteId: uuid("suite_id")
      .notNull()
      .references(() => evaluationSuites.id),
    benchmarkId: text("benchmark_id")
      .notNull()
      .references(() => benchmarkCases.id),
    caseVersionHash: text("case_version_hash").notNull(),
    arm: text("arm").notNull(),
    repetition: integer("repetition").notNull(),

    /** Null only when the runner could not create a job for this cell. */
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    result: text("result").notNull(),
    score: numeric("score", { precision: 5, scale: 4 }),
    failureCategory: text("failure_category"),
    failureLabelSource: text("failure_label_source"),
    metricsJson: jsonb("metrics_json").$type<Record<string, unknown>>().notNull(),
    gradedAt: timestamp("graded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("evaluation_runs_suite_benchmark_arm_repetition_unique").on(
      table.suiteId,
      table.benchmarkId,
      table.arm,
      table.repetition,
    ),
  ],
);

export type EvaluationRunRow = typeof evaluationRuns.$inferSelect;
export type NewEvaluationRunRow = typeof evaluationRuns.$inferInsert;
