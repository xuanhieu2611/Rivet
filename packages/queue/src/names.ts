/**
 * Every Redis-visible name in one place.
 *
 * Queue names end up as Redis key prefixes, so renaming one orphans whatever is
 * still in the old keyspace. Keeping them here means a rename is a single edit
 * plus a deliberate decision about the leftovers, rather than a string that
 * drifted apart across two packages.
 */

export const QUEUE_NAMES = {
  /** The one queue Milestone 1 has: a request to execute a job. */
  jobRuns: "job-runs",
} as const;

export const JOB_NAMES = {
  /** Payload: `{ jobId, dispatchGeneration }`. Everything else is read from Postgres. */
  runJob: "run-job",
  /** Payload: nothing. Produced by the recurring sweep scheduler. */
  sweep: "sweep",
} as const;

/**
 * The id of the recurring sweep in BullMQ's job-scheduler registry.
 *
 * Stable and shared by every worker: `upsertJobScheduler` is keyed on it, so N
 * workers starting up produce one schedule rather than N. Renaming it leaves
 * the old schedule running in Redis until something removes it.
 */
export const SCHEDULER_IDS = {
  sweep: "sweep-expired-leases",
} as const;

/**
 * The message body.
 *
 * The job id and dispatch generation are the only delivery facts. Postgres is
 * still the source of truth for everything else, so copying more state here
 * would create a second copy that can go stale between enqueue and claim.
 */
export interface JobRunPayload {
  jobId: string;
  dispatchGeneration: number;
}

/**
 * The sweep message carries nothing at all.
 *
 * `jobId?: never` rather than an empty object so the two payloads form a
 * discriminable union: a processor can read `job.data.jobId` on either without
 * a cast, and gets `undefined` for a sweep.
 */
export interface SweepPayload {
  jobId?: never;
  dispatchGeneration?: never;
}

/** Everything that can arrive on the `job-runs` queue. */
export type JobRunsMessage = JobRunPayload | SweepPayload;

/** BullMQ custom ids may not contain a colon, so use a dot as the separator. */
export function encodeJobRunId(jobId: string, dispatchGeneration: number): string {
  if (!Number.isSafeInteger(dispatchGeneration) || dispatchGeneration < 0) {
    throw new Error(`Invalid dispatch generation: ${dispatchGeneration}.`);
  }
  return `${jobId}.${dispatchGeneration}`;
}
