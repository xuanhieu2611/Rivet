import type { JobDetail, JobEventData, JobEventType, JobStatus } from "@rivet/contracts";
import { db, type Database, type Job, type NewJob, jobs } from "@rivet/database";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";

import { appendEvent } from "../events/event-service";
import { toJobDetail } from "./job-service";

/**
 * The one place `jobs.status` is written.
 *
 * Every status change has to satisfy two things, and both fall out of the
 * single function below: it is atomic with the event row that records it, and
 * it cannot clobber a change someone else made in the meantime. Any other
 * module writing `status` directly bypasses both, which is why the rule is
 * absolute rather than a preference.
 */

/**
 * Legal state transitions. Anything absent throws before touching the database.
 *
 * Milestone 1 only walks the simulated path, but the table covers the whole
 * lifecycle so later milestones add behaviour rather than structure.
 *
 * The `-> queued` edge on every in-flight status is the reclaim path: a sweeper
 * putting an orphaned job back on the queue is an ordinary legal transition,
 * not a special case that gets to bypass the guard.
 */
export const ALLOWED_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["provisioning", "cancelled", "failed"],
  provisioning: ["analyzing", "failed", "cancelled", "timed_out", "queued"],
  analyzing: ["planning", "failed", "cancelled", "timed_out", "queued"],
  planning: ["implementing", "failed", "cancelled", "timed_out", "queued"],
  implementing: ["testing", "failed", "cancelled", "timed_out", "budget_exceeded", "queued"],
  testing: ["reviewing", "implementing", "failed", "cancelled", "timed_out", "queued"],
  reviewing: ["revising", "finalizing", "failed", "cancelled", "timed_out", "queued"],
  revising: ["testing", "failed", "cancelled", "timed_out", "budget_exceeded", "queued"],
  finalizing: ["completed", "failed", "cancelled", "timed_out", "queued"],
  // Terminal. No outgoing edges, by definition and by test.
  completed: [],
  failed: [],
  cancelled: [],
  budget_exceeded: [],
  timed_out: [],
};

/** The caller asked for an edge the state machine does not have. A bug. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`Illegal job transition: ${from} -> ${to}.`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * The edge was legal but the row did not match the expected precondition.
 *
 * Not a bug: it means something else got there first. A cancel landed, the
 * sweeper reclaimed the job, or a second worker is running one it no longer
 * owns. Callers treat it as "stand down", never as "retry harder".
 */
export class TransitionConflictError extends Error {
  constructor(
    readonly jobId: string,
    readonly expectedFrom: readonly JobStatus[],
    readonly to: JobStatus,
    readonly leaseOwner?: string,
    /** What the row actually said, when it could be read. Absent if it is gone. */
    readonly actualStatus?: JobStatus,
  ) {
    super(
      `Job ${jobId} was not in [${expectedFrom.join(", ")}]` +
        (leaseOwner === undefined ? "" : ` under lease ${leaseOwner}`) +
        (actualStatus === undefined ? "" : ` (it is ${actualStatus})`) +
        `, so it was not moved to ${to}.`,
    );
    this.name = "TransitionConflictError";
  }
}

function asArray(from: JobStatus | readonly JobStatus[]): readonly JobStatus[] {
  return typeof from === "string" ? [from] : from;
}

/**
 * Throws `IllegalTransitionError` unless every status in `from` may reach `to`.
 *
 * Checked before the query rather than inferred from a zero-row update, so an
 * impossible edge fails loudly with the exact pair, instead of masquerading as
 * an ordinary conflict.
 */
export function assertTransitionAllowed(
  from: JobStatus | readonly JobStatus[],
  to: JobStatus,
): void {
  for (const status of asArray(from)) {
    if (!ALLOWED_TRANSITIONS[status].includes(to)) {
      throw new IllegalTransitionError(status, to);
    }
  }
}

/** Columns a transition may set. `status` is excluded - see `transitionJob`. */
export type TransitionPatch = Omit<Partial<NewJob>, "status">;

export interface TransitionInput {
  jobId: string;
  /** Expected current status, or any of several. The compare-and-swap half. */
  from: JobStatus | readonly JobStatus[];
  to: JobStatus;
  /**
   * When present, the update also requires the caller to still hold the lease.
   *
   * This is the fencing token. A worker that was reclaimed while it was busy
   * fails here rather than writing over the state its replacement is building.
   */
  leaseOwner?: string;
  /** One human-readable line for the timeline. */
  message: string;
  /** Event type, when the change deserves a more specific name than the default. */
  type?: JobEventType;
  data?: JobEventData;
  /**
   * An extra condition on the locked row, beyond status and lease ownership.
   *
   * A plain predicate rather than a SQL fragment, because by the time it runs
   * the row is locked and fully in hand - see below. `claimJob` uses it to
   * express "nobody holds a live lease on this", which is not a status and not
   * an equality check and would otherwise have to be inlined SQL that only this
   * module could read.
   *
   * `now` is the database's clock, not this process's.
   */
  precondition?: (current: Job, now: Date) => boolean;
  /**
   * Extra columns to set in the same statement: `completedAt`, `failureReason`,
   * lease bookkeeping.
   *
   * The function form receives the locked row and the database's clock, which
   * is how `claimJob` bumps `attempt_count` and computes a lease deadline
   * without a `sql` fragment and without trusting the worker's own clock.
   */
  patch?: TransitionPatch | ((current: Job, now: Date) => TransitionPatch);
}

/**
 * Moves a job to `to`, atomically with the event that records the move.
 *
 * The shape is lock, check, write, all inside one transaction:
 *
 * 1. `SELECT ... FOR UPDATE` takes the row lock and reads the job as it really
 *    is, along with the database's own `now()`.
 * 2. The preconditions are checked against that row: the status is in `from`
 *    (the compare-and-swap), the lease is still this caller's (the fence), and
 *    any caller-supplied `precondition` holds.
 * 3. The update and the event row go in together.
 *
 * The row lock is what makes step 2 safe to do in TypeScript instead of in the
 * `WHERE` clause: no other writer can slip between the read and the write,
 * because they all come through here and they all take the same lock. The
 * update keeps its own `status IN (from)` predicate anyway, so the guarantee
 * does not quietly depend on nobody ever deleting the `FOR UPDATE`.
 *
 * Doing it this way buys two things a single self-predicating UPDATE cannot:
 * the conflict error can say what the status actually was, and the event can
 * record the one concrete status the job moved away from rather than the set of
 * statuses the caller was willing to accept. A timeline entry reading
 * `from: ["testing", "reviewing", "revising"]` is not a fact about this job.
 *
 * Interactive transactions are the reason Milestone 0 chose the `pg` driver
 * over Neon's HTTP driver, and this function is what needs them.
 */
export async function transitionJob(
  input: TransitionInput,
  database: Database = db,
): Promise<JobDetail> {
  const expectedFrom = asArray(input.from);
  assertTransitionAllowed(expectedFrom, input.to);

  return database.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        job: getTableColumns(jobs),
        // `.mapWith` is load-bearing, not decoration. A bare `sql` fragment
        // hands back whatever the driver produced - a string, here - and
        // `sql<Date>` is only an assertion, so without this the first thing to
        // call `.getTime()` on it fails at runtime. Borrowing a real column's
        // mapper means this timestamp is decoded exactly like every other
        // timestamptz in the schema.
        now: sql`now()`.mapWith(jobs.createdAt),
      })
      .from(jobs)
      .where(eq(jobs.id, input.jobId))
      .limit(1)
      .for("update");

    const conflict = (actual?: JobStatus) =>
      new TransitionConflictError(input.jobId, expectedFrom, input.to, input.leaseOwner, actual);

    // No row at all: the job was deleted, or the id is a fiction. Either way
    // there is nothing to move, and the caller stands down the same as for any
    // other conflict.
    if (!locked) throw conflict();

    const { job: current, now } = locked;

    if (!expectedFrom.includes(current.status)) throw conflict(current.status);
    if (input.leaseOwner !== undefined && current.leaseOwner !== input.leaseOwner) {
      throw conflict(current.status);
    }
    if (input.precondition && !input.precondition(current, now)) throw conflict(current.status);

    const patch =
      typeof input.patch === "function" ? input.patch(current, now) : (input.patch ?? {});

    const [row] = await tx
      .update(jobs)
      .set({ ...patch, status: input.to })
      .where(and(eq(jobs.id, input.jobId), inArray(jobs.status, [...expectedFrom])))
      .returning();

    if (!row) {
      // Unreachable while the lock above is held. Kept so that the correctness
      // of this function does not rest on a comment.
      throw conflict(current.status);
    }

    await appendEvent(
      {
        jobId: input.jobId,
        type: input.type ?? "job.status_changed",
        message: input.message,
        // `current.status`, not `input.from`: the timeline records the status
        // the job was actually in, never the set the caller would have accepted.
        data: { ...input.data, from: current.status, to: input.to },
      },
      tx,
    );

    return toJobDetail(row);
  });
}
