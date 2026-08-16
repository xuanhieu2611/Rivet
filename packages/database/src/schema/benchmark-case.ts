import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The database registry for a source-controlled benchmark case.
 *
 * The files under `benchmarks/` are the source of truth. This table is a
 * refreshable registry so an evaluation run can retain the exact version and
 * base commit it used even after the checked-in case changes.
 */
export const benchmarkCases = pgTable("benchmark_cases", {
  /** The benchmark directory name, and therefore its stable identity. */
  id: text("id").primaryKey(),
  /** SHA-256 over the canonical case, seed tree and hidden tests. */
  versionHash: text("version_hash").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  difficulty: integer("difficulty").notNull(),
  /** The deterministic commit produced by the fixture builder. */
  baseCommitSha: text("base_commit_sha").notNull(),
  /** The validated case.json value, retained as the registry snapshot. */
  spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type BenchmarkCaseRow = typeof benchmarkCases.$inferSelect;
export type NewBenchmarkCaseRow = typeof benchmarkCases.$inferInsert;
