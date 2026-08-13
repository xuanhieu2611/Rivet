import type { JobDetail, JobEventData, JobEventType, JobStatus } from "@rivet/contracts";
import { db, type Database, type NewJob, jobs } from "@rivet/database";
import { and, eq, inArray } from "drizzle-orm";

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
  ) {
    super(
      `Job ${jobId} was not in [${expectedFrom.join(", ")}]` +
        (leaseOwner === undefined ? "" : ` under lease ${leaseOwner}`) +
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
   * Extra columns to set in the same statement: `completedAt`, `failureReason`,
   * lease bookkeeping. `status` is excluded from the type on purpose - this
   * function is the only thing allowed to set it.
   */
  patch?: Omit<Partial<NewJob>, "status">;
}

/**
 * Moves a job to `to`, atomically with the event that records the move.
 *
 * The update carries its own preconditions, so there is no read-then-write race
 * to lose: `status IN (from)` is the compare-and-swap and `lease_owner = ...`
 * is the fence. Zero rows updated means one of them did not hold.
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
    const [row] = await tx
      .update(jobs)
      .set({ ...input.patch, status: input.to })
      .where(
        and(
          eq(jobs.id, input.jobId),
          inArray(jobs.status, [...expectedFrom]),
          input.leaseOwner === undefined ? undefined : eq(jobs.leaseOwner, input.leaseOwner),
        ),
      )
      .returning();

    if (!row) {
      // Rolls the transaction back, so no event is written for a move that did
      // not happen.
      throw new TransitionConflictError(input.jobId, expectedFrom, input.to, input.leaseOwner);
    }

    await appendEvent(
      {
        jobId: input.jobId,
        type: input.type ?? "job.status_changed",
        message: input.message,
        data: { ...input.data, from: input.from, to: input.to },
      },
      tx,
    );

    return toJobDetail(row);
  });
}
