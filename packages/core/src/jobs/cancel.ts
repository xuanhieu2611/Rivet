import { isTerminal, type JobDetail, TERMINAL_STATUSES } from "@rivet/contracts";
import { db, type Database, jobs } from "@rivet/database";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";

import { appendEvent } from "../events/event-service";
import type { JobQueue } from "../queue/job-queue";
import { isJobId, toJobDetail } from "./job-service";
import { transitionJob, TransitionConflictError } from "./transitions";

/**
 * Cancelling a job, which is two quite different operations wearing one name.
 *
 * A job nobody has claimed can simply be cancelled: nothing is running, so the
 * status moves straight to `cancelled` and the queue message is thrown away. A
 * job a worker is holding cannot be, because only that worker can stop what it
 * is doing. All the API can do is record the request and let the worker act on
 * it - which it does on its next heartbeat, since `cancel_requested_at` comes
 * back on the same round trip that renews the lease.
 *
 * That second path is the reason this module exists rather than being three
 * lines in a route handler. **Stamping `cancel_requested_at` is not a status
 * change**, and it must not become one by accident: it writes a single intent
 * column and never touches `status`, leaving `transitionJob` as the only writer
 * of job state. The job reaches `cancelled` through the worker's own transition,
 * under its own lease, which is what keeps a cancel from landing in the middle
 * of a phase and corrupting a run this process cannot see.
 */

/**
 * What a cancel request did.
 *
 * The route handler maps these to status codes and does nothing else, which is
 * the point of returning a discriminated union rather than throwing: "already
 * finished" and "will stop shortly" are both ordinary outcomes.
 */
export type CancelOutcome =
  /** No such job. */
  | { outcome: "not_found" }
  /** It had not started. Cancelled outright, queue message dropped. */
  | { outcome: "cancelled"; job: JobDetail; queueError?: unknown }
  /** A worker holds it. The request is recorded; it stops within a heartbeat. */
  | { outcome: "cancel_requested"; job: JobDetail }
  /** It already finished, one way or another. Nothing to cancel. */
  | { outcome: "already_terminal"; job: JobDetail };

/**
 * Asks for `jobId` to stop, whatever state it is in.
 *
 * Idempotent in both directions: cancelling an already-cancelling job returns
 * `cancel_requested` without writing a second event, and cancelling a job that
 * has already reached `cancelled` returns `already_terminal` rather than an
 * error. A cancel button that gets double-clicked is not a client bug worth
 * reporting to the user.
 */
export async function requestJobCancellation(
  jobId: string,
  queue: JobQueue,
  database: Database = db,
): Promise<CancelOutcome> {
  // Checked before the query, because Postgres raises on a malformed uuid and a
  // 500 is the wrong answer to "cancel the job named `../etc/passwd`".
  if (!isJobId(jobId)) return { outcome: "not_found" };

  const [current] = await database.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!current) return { outcome: "not_found" };

  if (isTerminal(current.status)) {
    return { outcome: "already_terminal", job: toJobDetail(current) };
  }

  if (current.status === "queued") {
    const cancelled = await cancelQueuedJob(jobId, queue, database);
    // `null` means a worker claimed the job between the read above and the
    // write - the race this whole function is arranged around. It is in flight
    // now, so fall through to the cooperative path.
    if (cancelled) return cancelled;
  }

  return stampCancelRequest(jobId, database);
}

/**
 * The uncontested path: no worker has this job, so cancel it outright.
 *
 * Returns `null` when the compare-and-swap fails, which means the job stopped
 * being `queued` while this was running.
 */
async function cancelQueuedJob(
  jobId: string,
  queue: JobQueue,
  database: Database,
): Promise<CancelOutcome | null> {
  let job: JobDetail;
  try {
    job = await transitionJob(
      {
        jobId,
        from: "queued",
        to: "cancelled",
        message: "Cancelled before it started.",
        data: { failureCategory: "cancelled" },
        patch: (_row, now) => ({
          completedAt: now,
          failureCategory: "cancelled",
          leaseOwner: null,
          leaseExpiresAt: null,
        }),
      },
      database,
    );
  } catch (error) {
    if (error instanceof TransitionConflictError) return null;
    throw error;
  }

  // Postgres is already right; this is tidying. A message left behind is
  // harmless - the worker that receives it finds the job is no longer `queued`,
  // fails to claim it, and drops it - so an unreachable Redis must not turn a
  // successful cancellation into an error the caller has to interpret.
  try {
    await queue.removeJobRun(jobId);
    return { outcome: "cancelled", job };
  } catch (queueError) {
    return { outcome: "cancelled", job, queueError };
  }
}

/**
 * Records that someone wants this job stopped, and nothing else.
 *
 * One `UPDATE` sets one column. The predicates are what make it safe to run
 * without holding a lock: `cancel_requested_at IS NULL` makes a repeat call a
 * no-op instead of a second timeline entry, and excluding the terminal statuses
 * means a job that finished a millisecond ago cannot be stamped as pending
 * cancellation. Zero rows updated is therefore ambiguous by design, and the
 * re-read below is what disambiguates it.
 */
async function stampCancelRequest(jobId: string, database: Database): Promise<CancelOutcome> {
  return database.transaction(async (tx) => {
    const [stamped] = await tx
      .update(jobs)
      .set({ cancelRequestedAt: sql`now()` })
      .where(
        and(
          eq(jobs.id, jobId),
          isNull(jobs.cancelRequestedAt),
          notInArray(jobs.status, [...TERMINAL_STATUSES]),
        ),
      )
      .returning();

    if (stamped) {
      await appendEvent(
        {
          jobId,
          type: "job.cancel_requested",
          message: "Cancellation requested; the worker stops at its next heartbeat.",
        },
        tx,
      );
      return { outcome: "cancel_requested", job: toJobDetail(stamped) };
    }

    const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!row) return { outcome: "not_found" };
    if (isTerminal(row.status)) return { outcome: "already_terminal", job: toJobDetail(row) };

    // Non-terminal with a stamp already on it: someone asked first. Same answer,
    // no second event.
    return { outcome: "cancel_requested", job: toJobDetail(row) };
  });
}
