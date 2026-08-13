import { z } from "zod";

import type { JobStatus } from "./job";

/**
 * The vocabulary of the append-only job event log.
 *
 * Unlike `JOB_STATUSES`, this list is NOT a Postgres enum. Status is a closed
 * state machine that is indexed and queried on, so it earns a real enum plus a
 * drift assertion. Event types are a growing description of what happened, read
 * back only to render a timeline, and the list churns every milestone - paying
 * a migration per new entry buys nothing. The column is `text` and this schema
 * is the validation.
 */
export const JOB_EVENT_TYPES = [
  "job.created",
  "job.enqueued",
  /**
   * The row committed but the message did not land.
   *
   * The one visible symptom of the dual-write gap between Postgres and Redis.
   * It is not a failure of the job - the sweeper re-enqueues orphaned `queued`
   * rows - but it is worth seeing on the timeline when it happens.
   */
  "job.enqueue_failed",
  "job.claimed",
  "job.status_changed",
  "phase.started",
  "phase.completed",
  "job.cancel_requested",
  "job.retry_scheduled",
  /** The sweeper took the job back from a worker that went silent. */
  "job.reclaimed",
  /** A worker discovered it no longer owns the job and stood down. */
  "job.lease_lost",
  "job.failed",
  "job.completed",
] as const;

export const jobEventTypeSchema = z.enum(JOB_EVENT_TYPES);

export type JobEventType = z.infer<typeof jobEventTypeSchema>;

/**
 * Why a job ended badly, from PRD §23.
 *
 * Same reasoning as `JOB_EVENT_TYPES`: `text` in Postgres, validated here.
 * `cancelled` is present because a cancellation is recorded with a category
 * even though a cancelled job is not a failed job.
 */
export const FAILURE_CATEGORIES = [
  "worker_crash",
  "lease_expired",
  /** Milestone 1 only, from the fault injector. Deleted when the sandbox lands. */
  "simulated_failure",
  "timed_out",
  "budget_exceeded",
  "cancelled",
  "unknown",
] as const;

export const failureCategorySchema = z.enum(FAILURE_CATEGORIES);

export type FailureCategory = z.infer<typeof failureCategorySchema>;

/**
 * Reads a `failure_category` column back into the enum.
 *
 * A value outside the list can only come from a newer version of Rivet writing
 * to the same database, so it degrades to `unknown` rather than to `null`:
 * "we do not recognise this failure" and "this did not fail" are different
 * facts and the UI renders them differently.
 */
export function parseFailureCategory(value: string | null | undefined): FailureCategory | null {
  if (value === null || value === undefined) return null;
  const parsed = failureCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

/**
 * The structured half of an event, stored in the `data` jsonb column.
 *
 * Written as a type alias rather than an interface on purpose: TypeScript gives
 * object type aliases an implicit index signature, which is what makes this
 * assignable to the loose `Record<string, unknown>` the Drizzle column is typed
 * as. The database package cannot import this type without making the
 * contracts -> database dependency circular.
 *
 * Every field is optional because different event types populate different
 * subsets: a status change carries `from`/`to`, a phase carries
 * `phase`/`durationMs`, a failure carries `error`/`failureCategory`.
 */
// The implicit index signature described above is exactly what an interface lacks.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type JobEventData = {
  /** Expected prior status, as the transition's compare-and-swap stated it. */
  from?: JobStatus | readonly JobStatus[];
  to?: JobStatus;
  phase?: string;
  durationMs?: number;
  /** `jobs.attempt_count` at the time, not BullMQ's per-message retry count. */
  attempt?: number;
  failureCategory?: FailureCategory;
  error?: string;
  /** The lease owner involved, for reclaim and fencing events. */
  leaseOwner?: string;
};

/** One row of the job timeline. */
export interface JobEvent {
  /**
   * Globally monotonic across all jobs. Ordering within a job is what it is
   * for; Milestone 3 also uses it as the SSE `Last-Event-ID` cursor.
   */
  id: number;
  jobId: string;
  type: JobEventType;
  message: string;
  data: JobEventData | null;
  createdAt: Date;
}
