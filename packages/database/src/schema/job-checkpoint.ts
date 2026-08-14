import {
  bigserial,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { jobs } from "./job";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Independently restorable, append-only workspace snapshots.
 *
 * The payload is a gzip-compressed Git binary patch relative to the immutable
 * base commit. Metadata stays in typed columns so recovery can validate and
 * select a row without interpreting the JSON state or the payload.
 */
export const jobCheckpoints = pgTable(
  "job_checkpoints",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),

    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),

    sequence: integer("sequence").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    kind: text("kind").notNull(),
    completedPhase: text("completed_phase"),
    resumePhase: text("resume_phase").notNull(),
    agentTurn: integer("agent_turn"),
    baseCommitSha: text("base_commit_sha").notNull(),
    sandboxId: text("sandbox_id").notNull(),
    envFingerprint: jsonb("env_fingerprint").$type<Record<string, unknown>>().notNull(),
    stateJson: jsonb("state_json").$type<Record<string, unknown>>().notNull(),
    patchFormat: text("patch_format").notNull(),
    patchCompression: text("patch_compression").notNull(),
    patchSha256: text("patch_sha256").notNull(),
    patchByteSize: integer("patch_byte_size").notNull(),
    patchCompressedBytes: integer("patch_compressed_bytes").notNull(),
    patchPayload: bytea("patch_payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("job_checkpoints_job_id_sequence_unique").on(table.jobId, table.sequence),
    index("job_checkpoints_job_id_sequence_idx").on(table.jobId, table.sequence.desc()),
  ],
);

export type JobCheckpointRow = typeof jobCheckpoints.$inferSelect;
export type NewJobCheckpointRow = typeof jobCheckpoints.$inferInsert;
