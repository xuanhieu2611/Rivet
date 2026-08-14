import { db, type Database } from "@rivet/database";

import { appendEvent } from "../events/event-service";
import type { EnqueueOptions, EnqueueResult, JobQueue } from "../queue/job-queue";

/**
 * Asking for a job to run, and recording that you asked.
 *
 * This exists as its own module because of the dual-write problem it wraps.
 * There is no distributed transaction between Postgres and Redis: the row
 * commits first, then a message is sent, and the gap between them is real. If a
 * process dies in that gap, or Redis is unreachable, Postgres says `queued` and
 * Redis has nothing.
 *
 * Rivet's answer is deliberately not a two-phase commit. Postgres is the source
 * of truth, so a `queued` row with no message is a recoverable state, not a
 * lost job: the sweeper's second responsibility is finding rows that have sat
 * in `queued` with nothing behind them and enqueueing them again. Re-adding
 * with the job's encoded dispatch-generation id makes that safe to repeat.
 *
 * (A transactional outbox is the stronger answer, and it is deliberately not
 * built yet. It buys correctness this design already gets from reconciliation,
 * at the cost of a second table and a relay process.)
 *
 * What follows from all that: **a failed enqueue is not a failed request.**
 * `POST /api/jobs` still returns 201, because the job genuinely does exist.
 */
export interface EnqueueOutcome {
  /** What the queue did, or `null` when the message did not land at all. */
  result: EnqueueResult | null;
  /** Present only when `result` is `null`. The caller logs it. */
  error?: unknown;
}

/**
 * Enqueues a run for `jobId` and appends the matching timeline event.
 *
 * Never throws. A transport failure comes back as `{ result: null, error }`
 * and is recorded as `job.enqueue_failed`, so the job's own history shows why
 * nothing happened for a minute before the sweeper picked it up.
 */
export function requestJobRun(
  jobId: string,
  dispatchGeneration: number,
  queue: JobQueue,
  options?: EnqueueOptions,
  database?: Database,
): Promise<EnqueueOutcome>;
export function requestJobRun(
  jobId: string,
  queue: JobQueue,
  options?: EnqueueOptions,
  database?: Database,
): Promise<EnqueueOutcome>;
export async function requestJobRun(
  jobId: string,
  dispatchGenerationOrQueue: number | JobQueue,
  queueOrOptions?: JobQueue | EnqueueOptions,
  optionsOrDatabase?: EnqueueOptions | Database,
  database: Database = db,
): Promise<EnqueueOutcome> {
  const dispatchGeneration =
    typeof dispatchGenerationOrQueue === "number" ? dispatchGenerationOrQueue : 0;
  const queue = (
    typeof dispatchGenerationOrQueue === "number" ? queueOrOptions : dispatchGenerationOrQueue
  ) as JobQueue;
  const options = (
    typeof dispatchGenerationOrQueue === "number" ? optionsOrDatabase : queueOrOptions
  ) as EnqueueOptions | undefined;
  const executor =
    typeof dispatchGenerationOrQueue === "number"
      ? database
      : ((optionsOrDatabase as Database | undefined) ?? db);

  try {
    const result = await queue.enqueueJobRun(jobId, dispatchGeneration, options ?? {});
    await appendEvent(
      {
        jobId,
        type: "job.enqueued",
        message:
          result === "enqueued"
            ? "Queued for execution."
            : "Already queued for execution; no second message sent.",
        data: { dispatchGeneration },
      },
      executor,
    );
    return { result };
  } catch (error) {
    // Best effort. If the event write also fails there is nothing useful left
    // to do here, and the job is still safely `queued` for the sweeper.
    await appendEvent(
      {
        jobId,
        type: "job.enqueue_failed",
        message:
          "Could not reach the queue. The job is persisted and will be picked up by the sweeper.",
        data: { error: error instanceof Error ? error.message : String(error) },
      },
      executor,
    ).catch(() => undefined);

    return { result: null, error };
  }
}
