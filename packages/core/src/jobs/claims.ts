import {
  isTerminal,
  JOB_STATUSES,
  type JobDetail,
  type JobEventType,
  type JobStatus,
} from "@rivet/contracts";
import { db, type Database, jobs } from "@rivet/database";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Redactor } from "../telemetry/redaction";
import { transitionJob, TransitionConflictError } from "./transitions";

/**
 * Ownership of a job, expressed in Postgres rather than in Redis.
 *
 * The whole reliability story rests on this file. BullMQ has its own locks and
 * its own stalled-job detection, and they are fine as far as they go, but they
 * describe a *message*, not a job. A worker killed with `kill -9` mid-run never
 * tells Redis anything; a message that BullMQ gave up on says nothing about the
 * row it was pointing at. So Rivet keeps the authoritative answer to "who is
 * running this job, and are they still alive" in the same database as the job:
 *
 * - `lease_owner`  who holds it
 * - `lease_expires_at`  until when
 * - `heartbeat_at`  when they last said something
 *
 * A lease that has run out on a non-terminal job means the holder is gone,
 * whatever Redis believes. That single fact is what the sweeper acts on.
 */

/**
 * Statuses a worker can hold a lease in.
 *
 * Terminal statuses are finished and `queued` is by definition unowned, so what
 * is left is exactly the set a running worker can be interrupted in - which is
 * also the set the release and reclaim paths transition out of.
 */
export const LEASED_STATUSES: readonly JobStatus[] = JOB_STATUSES.filter(
  (status) => status !== "queued" && !isTerminal(status),
);

/** The first status a claimed job moves into, and the pipeline's first phase. */
const CLAIM_STATUS: JobStatus = "provisioning";

/**
 * Takes ownership of a queued job, or returns `null` if it cannot be had.
 *
 * `null` is the ordinary answer, not an error: the job was cancelled before a
 * worker got to it, another worker won the race, or a duplicate message arrived
 * for a job already in flight. All three mean "someone else's problem now".
 *
 * Two guards, both evaluated on the locked row inside `transitionJob`:
 * `status = 'queued'`, and no live lease. The second one matters even though
 * the first looks sufficient, because a crashed worker leaves a stale lease
 * behind and the sweeper is what clears it - claiming a `queued` row whose
 * lease has not yet expired would be jumping the reclaim queue.
 *
 * `startedAt` is coalesced rather than overwritten, so end-to-end duration stays
 * honest across a crash and a reclaim: it is when the work first began, not when
 * the last worker picked it up. `deadlineAt` is coalesced for the harder reason:
 * it is a ceiling, and a ceiling that moved on every claim would be one a crash
 * could reset.
 */
export async function claimJob(
  jobId: string,
  leaseOwner: string,
  leaseSeconds: number,
  dispatchGenerationOrDatabase: number | Database = 0,
  database: Database = db,
): Promise<JobDetail | null> {
  // Keep the old fourth-argument database form usable for callers that do not
  // need to override the initial generation, while making every real delivery
  // pass its generation explicitly. New generations are never inferred from
  // BullMQ state: the durable job row is the authority.
  const dispatchGeneration =
    typeof dispatchGenerationOrDatabase === "number" ? dispatchGenerationOrDatabase : 0;
  const executor =
    typeof dispatchGenerationOrDatabase === "number" ? database : dispatchGenerationOrDatabase;

  try {
    return await transitionJob(
      {
        jobId,
        from: "queued",
        to: CLAIM_STATUS,
        type: "job.claimed",
        message: `Claimed by ${leaseOwner} for dispatch generation ${dispatchGeneration}.`,
        data: (job) => ({
          leaseOwner,
          attempt: job.attemptCount + 1,
          dispatchGeneration,
        }),
        precondition: (job, now) =>
          job.dispatchGeneration === dispatchGeneration &&
          (job.leaseExpiresAt === null || job.leaseExpiresAt <= now),
        patch: (job, now) => ({
          leaseOwner,
          leaseExpiresAt: leaseDeadline(now, leaseSeconds),
          heartbeatAt: now,
          // Postgres's counter, not BullMQ's. This one counts every claim,
          // including reclaims after a crash that BullMQ never learned about.
          attemptCount: job.attemptCount + 1,
          startedAt: job.startedAt ?? now,
          // Established once and never extended, for the same reason
          // `startedAt` is coalesced rather than overwritten - except that this
          // one is enforcement rather than reporting. A job whose deadline moved
          // with every claim could buy another whole budget by crashing, which
          // would make the wall clock the one ceiling recovery resets. See
          // `jobs/deadline.ts`.
          deadlineAt: job.deadlineAt ?? new Date(now.getTime() + job.maxDurationSeconds * 1_000),
        }),
      },
      executor,
    );
  } catch (error) {
    if (error instanceof TransitionConflictError) return null;
    throw error;
  }
}

export interface HeartbeatResult {
  /** A cancel has been asked for. The worker aborts between phases. */
  cancelRequested: boolean;
  /** The job's status right now, as the database sees it. */
  status: JobStatus;
}

/**
 * Renews the lease, and reports back what the database knows.
 *
 * This is the nicest thing in the milestone: three concerns collapse into one
 * round trip every ten seconds.
 *
 * - **Liveness.** Pushing `lease_expires_at` forward is how a healthy worker
 *   tells the sweeper to leave its job alone.
 * - **Fencing.** The `lease_owner` predicate means a worker whose job was
 *   reclaimed out from under it gets `null` here and must abort immediately.
 *   Anything it wrote after that point would be the split-brain bug the lease
 *   exists to prevent.
 * - **Cancellation.** `cancel_requested_at` comes back on the same row, so
 *   cancel needs no pub/sub channel and no poll of its own. The API stamps a
 *   column; the worker notices within one interval.
 *
 * Note what this deliberately does NOT do: it never touches `status`. That is
 * `transitionJob`'s alone, and a heartbeat is not a state change. It is also
 * why the guard table can reject same-status transitions outright.
 */
export async function heartbeat(
  jobId: string,
  leaseOwner: string,
  leaseSeconds: number,
  database: Database = db,
): Promise<HeartbeatResult | null> {
  const [row] = await database
    .update(jobs)
    .set({
      heartbeatAt: sql`now()`,
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds}::double precision)`,
    })
    .where(
      and(eq(jobs.id, jobId), eq(jobs.leaseOwner, leaseOwner), sql`${jobs.leaseExpiresAt} > now()`),
    )
    .returning({ cancelRequestedAt: jobs.cancelRequestedAt, status: jobs.status });

  if (!row) return null;
  return { cancelRequested: row.cancelRequestedAt !== null, status: row.status };
}

export interface ReleaseOptions {
  /** One line for the timeline explaining why the job went back. */
  reason: string;
  /**
   * Defaults to `job.reclaimed`.
   *
   * A retry after a transient error is the same database write as a shutdown
   * handing work back, but they are different facts about the job, and the
   * timeline is where that distinction is worth keeping.
   */
  type?: JobEventType;
  /** Redacts the release reason before it becomes a durable event. */
  redactor?: Redactor;
}

/**
 * Hands a job back to the queue without failing it.
 *
 * A deploy, a Ctrl-C, or a worker draining should not cost a job its progress
 * or burn an attempt on a failure that never happened. The job goes back to
 * `queued`, the lease is cleared so the next worker can claim it immediately
 * rather than waiting out a 30-second expiry, and the timeline says why.
 *
 * The `-> queued` edge exists on every in-flight status for exactly this, which
 * is why releasing is an ordinary legal transition rather than a special case
 * that bypasses the guard table.
 *
 * Returns `null` when this worker no longer owns the job: something already
 * took it, and touching it now is the thing the fence is there to stop.
 */
export async function releaseJob(
  jobId: string,
  leaseOwner: string,
  options: ReleaseOptions,
  database: Database = db,
): Promise<JobDetail | null> {
  try {
    return await transitionJob(
      {
        jobId,
        from: LEASED_STATUSES,
        to: "queued",
        type: options.type ?? "job.reclaimed",
        message: options.reason,
        data: { leaseOwner },
        leaseOwner,
        ...(options.redactor ? { redactor: options.redactor } : {}),
        patch: { leaseOwner: null, leaseExpiresAt: null },
      },
      database,
    );
  } catch (error) {
    if (error instanceof TransitionConflictError) return null;
    throw error;
  }
}

/**
 * Is anybody actually running this job right now?
 *
 * The question the reaper asks about every container it finds, and the answer
 * has to come from Postgres for the same reason every other ownership question
 * does: Docker knows a container exists, and that is not evidence that the
 * process which created it is still alive. A job is live when it is in a leased
 * status *and* that lease has not expired, evaluated against the database's
 * clock rather than the sweeper's.
 *
 * Deliberately conservative in one direction and not the other. A job that has
 * been reclaimed is not live, so the container its dead worker left behind is
 * removed - which is the entire point. A job that is live keeps every container
 * labelled with its id, including one left over from a previous attempt on a
 * worker that crashed: the reaper's only handle is the job id, so it cannot
 * tell those apart, and sparing an extra container until the job reaches a
 * terminal status is much cheaper than removing the one a live run is using.
 */
export async function isJobLive(jobId: string, database: Database = db): Promise<boolean> {
  const [row] = await database
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, jobId),
        inArray(jobs.status, [...LEASED_STATUSES]),
        sql`${jobs.leaseExpiresAt} > now()`,
      ),
    )
    .limit(1);

  return row !== undefined;
}

/** Lease deadline `seconds` after the database's clock, never this process's. */
export function leaseDeadline(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1_000);
}
