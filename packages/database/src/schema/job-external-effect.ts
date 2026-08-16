import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { jobs } from "./job";

/**
 * Append-only receipts for effects Rivet has caused outside its database.
 *
 * The unique job/kind pair is the idempotency key for an external operation:
 * a replacement worker can ask whether the effect is already known without
 * risking a second receipt for the same publication step.
 */
export const jobExternalEffects = pgTable(
  "job_external_effects",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),

    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),

    /** The external operation this receipt acknowledges. */
    kind: text("kind").notNull(),
    /** The external system that owns the effect. */
    provider: text("provider").notNull(),
    /** GitHub's ref sha or pull-request node id, depending on `kind`. */
    externalId: text("external_id").notNull(),
    /** URL a reader can follow to inspect the effect. */
    externalUrl: text("external_url").notNull(),
    /** Provider-specific details retained for reconciliation and diagnosis. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("job_external_effects_job_id_kind_unique").on(table.jobId, table.kind),
    index("job_external_effects_job_id_id_idx").on(table.jobId, table.id),
  ],
);

export type JobExternalEffectRow = typeof jobExternalEffects.$inferSelect;
export type NewJobExternalEffectRow = typeof jobExternalEffects.$inferInsert;
