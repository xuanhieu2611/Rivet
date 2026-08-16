import { db, type Database, jobs } from "@rivet/database";
import { and, eq, sql } from "drizzle-orm";

import type { TransitionPatch } from "./transitions";

/**
 * Publication facts that become durable as the external operation answers.
 *
 * Status is deliberately excluded. `transitionJob()` remains the only status
 * writer, while these values become true at different moments from a phase
 * transition: the deterministic branch identity is persisted before the push,
 * and the PR identity is persisted before finalizing can move the job to completed.
 */
export type PublicationPatch = Pick<
  TransitionPatch,
  "finalBranch" | "pullRequestNumber" | "pullRequestUrl"
>;

/**
 * Records publication facts under the active worker lease.
 *
 * `false` means the worker was fenced out. The phase must stop rather than
 * writing a stale branch or pull-request identity into the replacement run.
 */
export async function recordPublication(
  jobId: string,
  leaseOwner: string,
  patch: PublicationPatch,
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
