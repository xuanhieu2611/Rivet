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
 * because everything below is expressed in terms of a job id and its durable
 * dispatch generation.
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
 * job generation is still in flight: enqueueing is idempotent on the encoded
 * `(jobId, dispatchGeneration)` key, which is what lets the API, the retry path
 * and the sweeper all call it without coordinating. Callers log the distinction
 * rather than acting on it.
 */
export type EnqueueResult = "enqueued" | "already-queued";

export interface JobQueue {
  /**
   * Asks for one durable dispatch generation of `jobId` to be run, at most once
   * concurrently.
   *
   * Idempotent by construction: the transport keys the message on the encoded
   * `(jobId, dispatchGeneration)` pair, so a duplicate call for the same
   * generation is a no-op. A new generation gets a new message id even while an
   * older generation is still active, which lets a sweeper redeliver work
   * immediately after a lease reclaim.
   */
  enqueueJobRun(
    jobId: string,
    dispatchGeneration: number,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult>;

  /**
   * Drops the outstanding message for one dispatch generation. Returns whether
   * one was removed.
   *
   * Used by cancellation of a job that has not started yet. A message that is
   * currently being processed cannot be removed - the worker holds it - so a
   * `false` here means "cancel cooperatively instead", not "failed".
   */
  removeJobRun(jobId: string, dispatchGeneration: number): Promise<boolean>;

  /** Releases the underlying connection. Only entrypoints call this. */
  close(): Promise<void>;
}
