import { db, type Database, jobs, type NewJob } from "@rivet/database";
import { and, eq } from "drizzle-orm";

/**
 * The agent totals a phase is allowed to write.
 *
 * This deliberately uses the same patch shape as `recordProvisioning`: the
 * database schema owns the names and types, while `status` stays excluded so
 * this writer cannot become a second status transition path.
 */
export type AgentUsagePatch = Pick<
  Omit<Partial<NewJob>, "status">,
  "totalInputTokens" | "totalOutputTokens" | "totalCostUsd"
>;

/**
 * Persists the cumulative agent usage for a job, fenced on its lease.
 *
 * The implementing phase seeds its totals from the claimed job row and writes
 * the running total after each completed usage event. That means an interrupted
 * session does not lose the usage it already reported, and a reclaimed attempt
 * continues from the totals left by its predecessor.
 *
 * `false` means the worker no longer owns the job. Callers turn that into a
 * `LeaseLostError` and stop writing, just like `recordProvisioning` does.
 */
export async function recordAgentUsage(
  jobId: string,
  leaseOwner: string,
  patch: AgentUsagePatch,
  database: Database = db,
): Promise<boolean> {
  if (Object.keys(patch).length === 0) return true;

  const [row] = await database
    .update(jobs)
    .set(patch)
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, leaseOwner)))
    .returning({ id: jobs.id });

  return row !== undefined;
}
