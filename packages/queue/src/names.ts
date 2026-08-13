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
