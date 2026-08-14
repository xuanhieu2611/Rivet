import type { JobDetail } from "@rivet/contracts";

/**
 * The job's wall-clock budget, counted once for the whole job.
 *
 * Milestone 5 gave every claim a fresh `maxDurationSeconds` timer, which was
 * fine while a claim was the only attempt a job ever got. It stops being fine
 * the moment a crashed job is reclaimed: a one-hour job that dies every
 * fifty-nine minutes would run forever, and the wall clock would be the one
 * ceiling a crash could reset. So the deadline is established once, on the first
 * claim, from the database's clock - see `claimJob` - and every later claim gets
 * only what is left of it.
 *
 * The consequence is deliberate and is stated in the recovery prompt and the UI
 * rather than hidden: time a job spent waiting for a replacement worker counts
 * against it, so a long outage can time out work that was otherwise recoverable.
 * Budget extension through repeated crashes is the worse of the two failures.
 */

/** The fields a deadline is computed from, so callers can pass a row or a detail. */
export interface DeadlineFacts {
  deadlineAt: Date | null;
  startedAt: Date | null;
  maxDurationSeconds: number;
}

/**
 * When this job's budget runs out, or null when nothing has started it.
 *
 * `deadline_at` is the authority whenever it is set. The fallback exists for
 * rows claimed before this column did, and for a worker whose claim path did not
 * set one: it is the same arithmetic the column stores, so an old job keeps the
 * budget it always had rather than becoming unbounded.
 */
export function jobDeadline(job: DeadlineFacts): Date | null {
  if (job.deadlineAt) return job.deadlineAt;
  if (!job.startedAt) return null;
  return new Date(job.startedAt.getTime() + job.maxDurationSeconds * 1_000);
}

/**
 * How long this job may still run, in milliseconds, never below zero.
 *
 * A job with no deadline at all - one that has never been claimed - gets its
 * full configured budget, which is what the first claim is about to make
 * durable anyway.
 */
export function remainingJobMs(job: DeadlineFacts, now: Date = new Date()): number {
  const deadline = jobDeadline(job);
  if (!deadline) return job.maxDurationSeconds * 1_000;
  return Math.max(0, deadline.getTime() - now.getTime());
}

/** Whether the wall-clock budget is already spent, before any work is started. */
export function isJobExpired(job: DeadlineFacts, now: Date = new Date()): boolean {
  return remainingJobMs(job, now) <= 0;
}

/** Whole minutes left, for the recovery prompt. Null when there is no deadline. */
export function remainingJobMinutes(job: JobDetail, now: Date = new Date()): number | null {
  if (!jobDeadline(job)) return null;
  return Math.max(0, Math.round(remainingJobMs(job, now) / 60_000));
}
