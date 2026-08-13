/**
 * The queue PORT: what the domain needs from a queue, and nothing more.
 *
 * This file is an interface and a couple of small types. It deliberately
 * contains no implementation, because the moment `@rivet/core` imports `bullmq`
 * the architecture's load-bearing claim stops being true: Postgres holds job
 * state, Redis only delivers messages. Domain logic that depends on the
 * delivery mechanism cannot make that claim.
 *
 * `packages/queue` supplies two implementations - the BullMQ adapter for the
 * real system, and an in-memory array for tests. Both are interchangeable here
 * because everything below is expressed in terms of a job id.
 */

export interface EnqueueOptions {
  /**
   * Wait this long before the message becomes visible to a worker.
   *
   * Used by the retry and reclaim paths, where re-running immediately would
   * just reproduce whatever went wrong.
   */
  delayMs?: number;
}

/**
 * What an enqueue actually did.
 *
 * `already-queued` is the normal, uninteresting answer when a message for this
 * job is still in flight: enqueueing is idempotent on the job id, which is what
 * lets the API, the retry path and the sweeper all call it without coordinating.
 * Callers log the distinction rather than acting on it.
 */
export type EnqueueResult = "enqueued" | "already-queued";

export interface JobQueue {
  /**
   * Asks for `jobId` to be run, at most once concurrently.
   *
   * Idempotent by construction: the transport keys the message on the job's
   * UUID, so a duplicate call while the first is still outstanding is a no-op.
   * A job that has already finished its previous message can be enqueued again,
   * which is what makes retry and sweeper reclaim work.
   */
  enqueueJobRun(jobId: string, options?: EnqueueOptions): Promise<EnqueueResult>;

  /**
   * Drops any outstanding message for `jobId`. Returns whether one was removed.
   *
   * Used by cancellation of a job that has not started yet. A message that is
   * currently being processed cannot be removed - the worker holds it - so a
   * `false` here means "cancel cooperatively instead", not "failed".
   */
  removeJobRun(jobId: string): Promise<boolean>;

  /** Releases the underlying connection. Only entrypoints call this. */
  close(): Promise<void>;
}
