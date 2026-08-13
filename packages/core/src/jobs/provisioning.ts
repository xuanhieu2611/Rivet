import { db, type Database, jobs, type NewJob } from "@rivet/database";
import { and, eq } from "drizzle-orm";

/**
 * The columns that describe what a run is executing in.
 *
 * This is the fourth - and, at Milestone 2, the last - place in `packages/`
 * that issues an `.update(jobs)`. The other three are `transitions.ts` (status,
 * and only status), `claims.ts` (the lease) and `cancel.ts` (the cancel stamp).
 * Adding one is not free, so it is worth writing down why this is not smuggled
 * onto the next phase's transition patch instead:
 *
 * - `base_commit_sha` becomes true when `git rev-parse` answers, not when the
 *   job later moves to `analyzing`. A fact recorded at a moment that has
 *   nothing to do with the fact is how a timeline starts lying.
 * - A provisioning that fails after the clone still leaves the resolved commit
 *   and the container id behind, which is exactly what someone debugging that
 *   failure needs. A transition patch would only land on success.
 *
 * What keeps it safe is the same two things every other writer has. It cannot
 * touch `status` - the patch type is the shared `Omit<Partial<NewJob>, "status">`,
 * so a status will not typecheck - and every write is fenced on `lease_owner`,
 * so a worker that was reclaimed mid-phase writes nothing.
 */
export type ProvisioningPatch = Pick<
  Omit<Partial<NewJob>, "status">,
  "sandboxId" | "baseCommitSha" | "envFingerprint"
>;

/**
 * Records what the sandbox is, fenced on the lease.
 *
 * Returns `false` when no row matched, which means one thing only: this worker
 * no longer owns the job. The caller turns that into `LeaseLostError` and stops
 * touching the job entirely - see `classify()`. It is deliberately not an
 * exception here, because "the row moved on" is an ordinary outcome of a
 * fenced write and the fencing is the point.
 */
export async function recordProvisioning(
  jobId: string,
  leaseOwner: string,
  patch: ProvisioningPatch,
  database: Database = db,
): Promise<boolean> {
  // An empty patch would produce `UPDATE jobs SET WHERE ...`, which Drizzle
  // rejects at runtime. Nothing to write is not an error; it is a no-op that
  // must not be mistaken for a lost lease.
  if (Object.keys(patch).length === 0) return true;

  const [row] = await database
    .update(jobs)
    .set(patch)
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, leaseOwner)))
    .returning({ id: jobs.id });

  return row !== undefined;
}
