import { z } from "zod";

import { jobStatusSchema, type JobStatus } from "./job";

/**
 * The vocabulary of a job's durable output.
 *
 * Follows `JOB_EVENT_TYPES` rather than `JOB_STATUSES`: `job_artifacts.type` is
 * `text` and this schema is the validation, because the list grows every
 * milestone - a plan in M6, validation reports in M7, review reports in M8 - and
 * is never queried as a state machine. A migration per new entry buys nothing.
 *
 * Milestone 5 declares three:
 *
 * - `diff` - `git diff --cached` against the clone's `base_commit_sha`. A diff
 *   rather than a commit: M9 owns git identity, branch and push.
 * - `diff_stat` - the parsed `--numstat` totals for that diff.
 * - `implementation_summary` - the last assistant message of the session,
 *   describing what changed and why.
 * - `implementation_plan` - the canonical JSON representation of the structured
 *   plan submitted by the planning session.
 */
export const ARTIFACT_TYPES = [
  "diff",
  "diff_stat",
  "implementation_summary",
  "implementation_plan",
] as const;

export const artifactTypeSchema = z.enum(ARTIFACT_TYPES);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

/**
 * One durable output of a job, with its content.
 *
 * A separate table from `job_events` for the same reason `job_commands` is: the
 * event log is read in full on every timeline render and is supposed to hold
 * small facts. A 200KB diff is neither. The timeline keeps an
 * `artifact.recorded` row carrying the id, the type and the byte size; the
 * content lives one fetch away.
 *
 * Append-only. Nothing ever updates a row.
 */
export interface JobArtifact extends JobArtifactSummary {
  /** Truncated head+tail to the configured bound, with the elision marked inline. */
  content: string;
}

/**
 * What a list query reads back: everything except the content.
 *
 * The split exists so the detail page can say which artifacts a job produced,
 * how big each one really was, and whether it was truncated, without pulling
 * every byte of a diff into a page render.
 */
export interface JobArtifactSummary {
  /** Globally monotonic, same reasoning as `JobEvent.id`. Also the cursor. */
  id: number;
  jobId: string;
  type: ArtifactType;
  /** The `JobStatus` the job was in when the artifact was produced. */
  phase: JobStatus;
  /** The true size before truncation, which is the whole point of storing it separately. */
  byteSize: number;
  /** True when content hit the bound and the stored text has a gap in the middle. */
  truncated: boolean;
  /** Type-specific structure, e.g. the parsed totals on a `diff_stat`. */
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

/** The JSON shape used when an artifact summary crosses a server/client boundary. */
export type SerializedJobArtifactSummary = Omit<JobArtifactSummary, "createdAt"> & {
  createdAt: string;
};

/** The JSON shape used when artifact content crosses a server/client boundary. */
export type SerializedJobArtifact = Omit<JobArtifact, "createdAt"> & { createdAt: string };

const safeArtifactIdSchema = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "Artifact id must be a safe integer.");

const artifactDateSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Artifact date must be a valid ISO date.");

const serializedJobArtifactSummarySchema = z.object({
  id: safeArtifactIdSchema,
  jobId: z.string().min(1),
  type: artifactTypeSchema,
  phase: jobStatusSchema,
  byteSize: z.number().int().nonnegative(),
  truncated: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: artifactDateSchema,
});

const serializedJobArtifactSchema = serializedJobArtifactSummarySchema.extend({
  content: z.string(),
});

/** Converts an artifact summary into the JSON shape sent to the browser. */
export function serializeJobArtifactSummary(
  artifact: JobArtifactSummary,
): SerializedJobArtifactSummary {
  return { ...artifact, createdAt: artifact.createdAt.toISOString() };
}

/** Converts an artifact into the JSON shape sent to the browser. */
export function serializeJobArtifact(artifact: JobArtifact): SerializedJobArtifact {
  return { ...artifact, createdAt: artifact.createdAt.toISOString() };
}

/** Validates a JSON artifact summary and restores its in-memory `Date` value. */
export function parseSerializedJobArtifactSummary(value: unknown): JobArtifactSummary {
  const parsed = serializedJobArtifactSummarySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid job artifact summary: ${parsed.error.message}`);
  }

  return { ...parsed.data, createdAt: new Date(parsed.data.createdAt) };
}

/** Validates a JSON artifact and restores its in-memory `Date` value. */
export function parseSerializedJobArtifact(value: unknown): JobArtifact {
  const parsed = serializedJobArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid job artifact: ${parsed.error.message}`);
  }

  return { ...parsed.data, createdAt: new Date(parsed.data.createdAt) };
}
