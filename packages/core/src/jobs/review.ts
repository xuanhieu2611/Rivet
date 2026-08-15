import type { ReviewDecision } from "@rivet/contracts";
import { db, type Database, jobs } from "@rivet/database";
import { and, eq, sql } from "drizzle-orm";

import type { TransitionPatch } from "./transitions";

/**
 * The review facts that become durable when a reviewer submits a verdict.
 *
 * `status` is omitted for the same reason it is omitted from every other
 * non-transition job writer: review accounting must never become a second
 * path for changing the job state. The fields are picked from the same
 * status-free transition patch shape used by the other job writers.
 */
export type ReviewPatch = Pick<
  TransitionPatch,
  "reviewDecision" | "reviewLoops" | "reviewBlockingCount"
> & {
  reviewDecision?: ReviewDecision | null;
};

/**
 * Persists the last review verdict and the durable loop counter under the
 * active worker lease.
 *
 * `false` means the worker was fenced out. The phase turns that into
 * `LeaseLostError` rather than allowing a stale reviewer to publish facts into
 * the replacement attempt.
 */
export async function recordReview(
  jobId: string,
  leaseOwner: string,
  patch: ReviewPatch,
  database: Database = db,
): Promise<boolean> {
  if (Object.keys(patch).length === 0) return true;

  const [row] = await database
    .update(jobs)
    .set(patch)
    .where(
      and(eq(jobs.id, jobId), eq(jobs.leaseOwner, leaseOwner), sql`${jobs.leaseExpiresAt} > now()`),
    )
    .returning({ id: jobs.id });

  return row !== undefined;
}
