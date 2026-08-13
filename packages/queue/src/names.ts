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
  /** Payload: `{ jobId }`. Everything else is read from Postgres. */
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
 * Just the id, on purpose. Postgres is the source of truth, so anything else
 * copied in here would be a second copy that can go stale between the enqueue
 * and the moment a worker picks it up.
 */
export interface JobRunPayload {
  jobId: string;
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
}

/** Everything that can arrive on the `job-runs` queue. */
export type JobRunsMessage = JobRunPayload | SweepPayload;
