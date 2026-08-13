import type { JobStatus } from "@rivet/contracts";
import { db, type Database, jobs } from "@rivet/database";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { appendEvent } from "../events/event-service";
import type { JobQueue } from "../queue/job-queue";
import { LEASED_STATUSES } from "./claims";
import { requestJobRun } from "./enqueue";
import { transitionJob, TransitionConflictError } from "./transitions";

/**
 * Reconciliation: the loop that makes "Postgres holds job state, Redis only
 * delivers messages" true rather than aspirational.
 *
 * Two independent leaks exist between the two datastores, and this module
 * closes both of them. They are not variations of one problem - they fail in
 * opposite directions - and each is worth being able to describe:
 *
 * 1. **A job Postgres thinks is running, that nothing is running.** A worker
 *    killed with `kill -9`, an OOM, a disappearing container: none of them get
 *    to tell Redis or Postgres anything. What is left behind is a row in a
 *    leased status whose `lease_expires_at` has quietly passed. BullMQ's own
 *    stalled-job detection cannot help here, because it reasons about the
 *    *message*, and a message whose worker vanished mid-run says nothing about
 *    how far the job got. `reclaimExpiredJobs` is the answer.
 *
 * 2. **A job Postgres thinks is queued, that no message points at.** This is
 *    the dual-write gap. `POST /api/jobs` commits the row and *then* sends the
 *    message; there is no distributed transaction between Postgres and Redis
 *    and deliberately no transactional outbox yet. If the process dies in
 *    between, or Redis is unreachable, or Redis loses data, the row sits in
 *    `queued` forever with nothing coming for it. `requeueOrphanedJobs` is the
 *    answer, and it is the entire reason a failed enqueue is allowed to return
 *    `201` instead of failing the request.
 *
 * Neither half needs to be exactly-once, and neither tries to be. Re-enqueueing
 * is idempotent on the job id, and every status write goes through
 * `transitionJob`'s compare-and-swap, so the worst a redundant sweep can do is
 * lose a race and write nothing.
 */

/** Scan size per category per pass. Enough that a backlog drains, not a batch job. */
export const DEFAULT_SWEEP_LIMIT = 50;

/**
 * How long a row may sit in `queued` before its message is presumed missing.
 *
 * Only a lower bound on wasted work, never on correctness: enqueueing an id
 * that already has a message outstanding is a no-op, so a threshold that is too
 * short costs a redundant Redis round trip and nothing else. It exists at all
 * so that the normal path - insert, enqueue a millisecond later - is not
 * constantly mistaken for the failure it resembles for that millisecond.
 */
export const DEFAULT_ORPHANED_QUEUED_AFTER_MS = 60_000;

export interface SweepOptions {
  /**
   * Postgres's attempt ceiling, not BullMQ's.
   *
   * A job that has been claimed this many times and still has not finished is
   * failed rather than reclaimed again. Without it, a job that reliably kills
   * its worker would be reclaimed forever, taking a worker down each time.
   */
  maxAttempts: number;
  /** Rows examined per category per pass. */
  limit?: number;
  /** See `DEFAULT_ORPHANED_QUEUED_AFTER_MS`. */
  orphanedQueuedAfterMs?: number;
}

/**
 * What the sweeper did with one expired lease.
 *
 * `skipped` means another sweeper, or the original worker waking up at exactly
 * the wrong moment, got there first: the compare-and-swap failed and this pass
 * correctly wrote nothing.
 */
export type ReclaimOutcome = "reclaimed" | "cancelled" | "failed" | "skipped";

export interface ReclaimResult {
  jobId: string;
  /** The status the job was stranded in. */
  from: JobStatus;
  outcome: ReclaimOutcome;
  /** The worker that is presumed dead, when the row still named one. */
  leaseOwner: string | null;
  /** `jobs.attempt_count` as it stood before this pass. */
  attemptCount: number;
}

export interface RequeueResult {
  jobId: string;
  /** `already-queued` means the message was there all along and nothing leaked. */
  outcome: "enqueued" | "already-queued" | "error";
  error?: unknown;
}

export interface SweepReport {
  expiredLeases: ReclaimResult[];
  orphanedQueued: RequeueResult[];
}

/**
 * One full pass: expired leases first, then orphaned `queued` rows.
 *
 * The order matters slightly. Reclaiming puts jobs back into `queued`, and
 * those rows have just been enqueued by the reclaim itself, so they are far
 * too fresh for the orphan threshold to pick up in the same pass. Running the
 * other way round would be equally correct, just noisier to read in a log.
 */
export async function sweepJobs(
  queue: JobQueue,
  options: SweepOptions,
  database: Database = db,
): Promise<SweepReport> {
  return {
    expiredLeases: await reclaimExpiredJobs(queue, options, database),
    orphanedQueued: await requeueOrphanedJobs(queue, options, database),
  };
}

/** True when a pass found nothing to do, which is the normal case. */
export function isQuietSweep(report: SweepReport): boolean {
  return (
    report.expiredLeases.length === 0 &&
    report.orphanedQueued.every((result) => result.outcome === "already-queued")
  );
}

/**
 * Finds jobs whose owner has gone silent and decides what becomes of each.
 *
 * The scan is `FOR UPDATE ... SKIP LOCKED`, which is what lets several workers
 * sweep on the same schedule without either blocking on each other or doing
 * each other's work twice. Note what it is *not* doing: the lock is taken and
 * released by this statement alone, not held across the transitions below. It
 * cannot be, because the transitions have to be free to enqueue afterwards and
 * a Postgres transaction held open across a Redis round trip is a bad trade.
 *
 * That is safe because the lock was never the thing protecting correctness -
 * `transitionJob`'s compare-and-swap is. If two sweepers do pick the same job,
 * the second one's transition finds a status it did not expect and returns
 * `skipped`. `SKIP LOCKED` is here to stop concurrent sweepers *queueing up
 * behind* a row that is mid-reclaim, which is a throughput property, not a
 * correctness one.
 *
 * Three outcomes, in priority order:
 *
 * - **Cancellation was already requested.** Short-circuit to `cancelled`. See
 *   `reclaimOne` for why this beats replaying the pipeline.
 * - **Attempts exhausted.** `failed`, with `failure_category: lease_expired`.
 *   This is the honest category: nobody observed the job fail, its worker just
 *   stopped answering, and saying so is more useful than guessing `unknown`.
 * - **Attempts remaining.** Back to `queued`, lease cleared, `job.reclaimed` on
 *   the timeline, and a fresh message. `attempt_count` is *not* bumped here;
 *   the next claim does that, so the counter keeps meaning "times a worker
 *   picked this up" rather than "times something touched it".
 */
export async function reclaimExpiredJobs(
  queue: JobQueue,
  options: SweepOptions,
  database: Database = db,
): Promise<ReclaimResult[]> {
  const candidates = await database
    .select({
      id: jobs.id,
      status: jobs.status,
      attemptCount: jobs.attemptCount,
      leaseOwner: jobs.leaseOwner,
      cancelRequestedAt: jobs.cancelRequestedAt,
    })
    .from(jobs)
    .where(
      and(
        // Terminal jobs are finished and `queued` jobs are unowned by
        // definition, so this is exactly the set a worker can die holding.
        inArray(jobs.status, [...LEASED_STATUSES]),
        // A leased status with no deadline at all should be impossible, since
        // every transition into one sets the lease in the same statement. If it
        // ever happens it is an orphan by definition and forever invisible to a
        // `lease_expires_at < now()` predicate, so it is caught here instead.
        or(isNull(jobs.leaseExpiresAt), lt(jobs.leaseExpiresAt, sql`now()`)),
      ),
    )
    .limit(options.limit ?? DEFAULT_SWEEP_LIMIT)
    .for("update", { skipLocked: true });

  const results: ReclaimResult[] = [];

  for (const candidate of candidates) {
    results.push(await reclaimOne(candidate, options.maxAttempts, database));
  }

  // Enqueued only after every write has committed. A message for a transaction
  // that later rolled back would be a worker racing to claim a job that is
  // still, as far as Postgres is concerned, owned by a dead process. If this
  // process dies between the commit and the enqueue, the row is sitting in
  // `queued` with no message - which is leak (2), and the next pass fixes it.
  //
  // One case does not produce a new message, and it is worth knowing about
  // because it is the `kill -9` case specifically: the dead worker's message is
  // still sitting in Redis marked `active`, since nothing told Redis otherwise
  // either. The adapter will not displace a message that is not finished, so
  // this enqueue answers `already-queued` and no redelivery happens here. That
  // is correct rather than a gap - the message genuinely still exists - but it
  // does mean recovery in that case waits for BullMQ's stalled-job detection to
  // notice the expired lock and move the message back to `wait`, rather than
  // for this sweep. The row is already back in `queued`, so whichever worker
  // eventually receives that message claims it and runs it.
  //
  // The practical consequence: end-to-end crash recovery takes as long as the
  // slower of the two mechanisms, Rivet's lease expiry plus a sweep interval,
  // or BullMQ's `lockDuration` plus `stalledInterval`. Both are on the order of
  // a minute by default, and neither can be dropped: BullMQ's half cannot see
  // the job row, and this half cannot displace a live message.
  for (const result of results) {
    if (result.outcome === "reclaimed") {
      await requestJobRun(result.jobId, queue, {}, database);
    }
  }

  return results;
}

interface ReclaimCandidate {
  id: string;
  status: JobStatus;
  attemptCount: number;
  leaseOwner: string | null;
  cancelRequestedAt: Date | null;
}

async function reclaimOne(
  candidate: ReclaimCandidate,
  maxAttempts: number,
  database: Database,
): Promise<ReclaimResult> {
  const base = {
    jobId: candidate.id,
    from: candidate.status,
    leaseOwner: candidate.leaseOwner,
    attemptCount: candidate.attemptCount,
  };
  const owner = candidate.leaseOwner ?? "an unknown worker";
  // `exactOptionalPropertyTypes`: an unknown owner is an absent key, not an
  // explicit `undefined`.
  const ownerData = candidate.leaseOwner === null ? {} : { leaseOwner: candidate.leaseOwner };

  try {
    // A cancel that was requested while the worker was alive but never acted on,
    // because the worker died before its next heartbeat. Replaying the pipeline
    // here would be actively wrong: someone asked for this job to stop, the only
    // reason it did not is that its worker was killed, and a job visibly
    // resuming after a cancel is the sort of thing nobody trusts again. The
    // cooperative path exists solely because a live lease holder is the only
    // process allowed to end a running job - and the lease has now expired, so
    // there is no such process and the sweeper may honour the request directly.
    //
    // It also matters that this is checked *before* the attempt ceiling: a
    // cancelled job must not be recorded as `failed` just because it happened
    // to be on its last attempt when its worker died.
    if (candidate.cancelRequestedAt !== null) {
      await transitionJob(
        {
          jobId: candidate.id,
          from: candidate.status,
          to: "cancelled",
          message: `Cancelled while ${owner} was unreachable; its lease expired.`,
          data: { failureCategory: "cancelled", ...ownerData },
          patch: (_job, now) => ({
            completedAt: now,
            failureCategory: "cancelled",
            leaseOwner: null,
            leaseExpiresAt: null,
          }),
        },
        database,
      );
      return { ...base, outcome: "cancelled" };
    }

    if (candidate.attemptCount >= maxAttempts) {
      const reason =
        `Lease held by ${owner} expired after ${candidate.attemptCount} ` +
        `attempt(s); no attempts remain.`;
      await transitionJob(
        {
          jobId: candidate.id,
          from: candidate.status,
          to: "failed",
          type: "job.failed",
          message: reason,
          data: { failureCategory: "lease_expired", ...ownerData },
          patch: (_job, now) => ({
            completedAt: now,
            failureReason: reason,
            failureCategory: "lease_expired",
            leaseOwner: null,
            leaseExpiresAt: null,
          }),
        },
        database,
      );
      return { ...base, outcome: "failed" };
    }

    await transitionJob(
      {
        jobId: candidate.id,
        from: candidate.status,
        to: "queued",
        type: "job.reclaimed",
        message: `Lease held by ${owner} expired; returned to the queue.`,
        data: { ...ownerData, attempt: candidate.attemptCount },
        // Clearing the lease is what lets the next worker claim immediately
        // instead of waiting out an expiry that has already passed.
        patch: { leaseOwner: null, leaseExpiresAt: null },
      },
      database,
    );
    return { ...base, outcome: "reclaimed" };
  } catch (error) {
    if (error instanceof TransitionConflictError) {
      // Somebody else got there between the scan and the write. Their version
      // wins; this pass deliberately leaves no trace.
      return { ...base, outcome: "skipped" };
    }
    throw error;
  }
}

/**
 * The dual-write reconciliation: `queued` rows with no message behind them.
 *
 * This is the half of the sweeper that makes the durability claim in
 * `docs/architecture.md` literally true. Postgres commits the job row, and only
 * then is a message sent to Redis; the two writes are not atomic and no amount
 * of care in `requestJobRun` can make them so. What makes the gap survivable
 * rather than lossy is that Postgres is the source of truth and this function
 * exists: any row that says `queued` will be run, whether or not the message
 * that was supposed to carry it ever arrived. Flush Redis entirely and every
 * outstanding job still runs, one sweep interval later.
 *
 * Three distinct histories land in the same state and are all repaired here:
 * the enqueue threw (`job.enqueue_failed` is on the timeline), the process died
 * between the commit and the send (nothing on the timeline at all), or Redis
 * lost the message after accepting it.
 *
 * It also catches a fourth, which is not a leak but wants the same repair: a
 * job BullMQ has stopped retrying. The processor releases a transiently failed
 * job back to `queued` and rethrows so BullMQ applies its backoff; when BullMQ
 * exhausts its own attempts it stops, and the row is left sitting in `queued`.
 * Re-enqueueing here is what the processor's comment means by "the sweeper is
 * the backstop", and it works only because the adapter clears a finished
 * message before reusing its id.
 *
 * No status is written and nothing is claimed, so this is idempotent to the
 * point of being uninteresting: enqueueing an id that already has an
 * outstanding message returns `already-queued` and nothing happens.
 */
export async function requeueOrphanedJobs(
  queue: JobQueue,
  options: SweepOptions,
  database: Database = db,
): Promise<RequeueResult[]> {
  const staleSeconds = (options.orphanedQueuedAfterMs ?? DEFAULT_ORPHANED_QUEUED_AFTER_MS) / 1_000;

  const stale = await database
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "queued"),
        // `updated_at` rather than `created_at`, so a job that has been through
        // a retry or a reclaim gets its own grace period rather than being
        // judged on when it was first created.
        lt(jobs.updatedAt, sql`now() - make_interval(secs => ${staleSeconds}::double precision)`),
      ),
    )
    .limit(options.limit ?? DEFAULT_SWEEP_LIMIT)
    // Skips rows another sweeper is mid-reclaim on. Those are about to become
    // `queued` with a message of their own, so touching them here would be
    // duplicated work at best.
    .for("update", { skipLocked: true });

  const results: RequeueResult[] = [];

  for (const { id } of stale) {
    try {
      const outcome = await queue.enqueueJobRun(id);
      if (outcome === "enqueued") {
        // Recorded only when a message genuinely had to be re-sent. The `queued`
        // rows examined here are re-examined every single pass, and writing an
        // event for each would bury the timeline of a job that is merely waiting
        // its turn under a heartbeat of noise.
        await appendEvent(
          {
            jobId: id,
            type: "job.enqueued",
            message: "Re-queued by the sweeper: the row was waiting with no message behind it.",
          },
          database,
        );
      }
      results.push({ jobId: id, outcome });
    } catch (error) {
      // Redis is unreachable. The row stays `queued`, which is exactly where it
      // needs to be for the next pass to try again, so this is reported rather
      // than thrown - one unreachable job must not abandon the rest of the pass.
      results.push({ jobId: id, outcome: "error", error });
    }
  }

  return results;
}
