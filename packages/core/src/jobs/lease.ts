import { db, type Executor, jobs } from "@rivet/database";
import { and, eq, sql } from "drizzle-orm";

import { LeaseLostError } from "./failure";

/**
 * Locks a job row and proves that a worker still owns an unexpired lease.
 *
 * Callers use this inside the transaction that will write the fenced fact. The
 * row lock makes the check and the following insert one serialized decision:
 * either the worker gets the lock before reclaim and commits its fact first, or
 * reclaim gets it first and this check fails against the replacement owner.
 */
export async function assertActiveLease(
  jobId: string,
  leaseOwner: string,
  executor: Executor = db,
): Promise<void> {
  const [row] = await executor
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(eq(jobs.id, jobId), eq(jobs.leaseOwner, leaseOwner), sql`${jobs.leaseExpiresAt} > now()`),
    )
    .limit(1)
    .for("update");

  if (!row) {
    throw new LeaseLostError(`Job ${jobId} is no longer leased by ${leaseOwner}.`);
  }
}
