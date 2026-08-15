import { parseSerializedBaselineReport, type BaselineReport } from "@rivet/contracts";
import { db, type Executor, jobArtifacts } from "@rivet/database";
import { and, desc, eq } from "drizzle-orm";

/**
 * Reads the newest complete baseline report from the durable artifact store.
 *
 * Validation cannot rely on the process that ran `analyzing`: recovery may
 * enter `testing` in a replacement worker and a freshly provisioned sandbox.
 * A missing, truncated, or unparseable report returns null so callers can fall
 * back to the legacy `baseline.recorded` event used by pre-M7 jobs.
 */
export async function readBaselineReport(
  jobId: string,
  executor: Executor = db,
): Promise<BaselineReport | null> {
  const [row] = await executor
    .select({ content: jobArtifacts.content, truncated: jobArtifacts.truncated })
    .from(jobArtifacts)
    .where(and(eq(jobArtifacts.jobId, jobId), eq(jobArtifacts.type, "baseline_report")))
    .orderBy(desc(jobArtifacts.id))
    .limit(1);

  return baselineReportFrom(row ? [row] : []);
}

export interface BaselineReportArtifactLike {
  content: string;
  truncated: boolean;
}

/** Parses the newest row only. A corrupt latest attempt must trigger legacy fallback. */
export function baselineReportFrom(
  rowsNewestFirst: readonly BaselineReportArtifactLike[],
): BaselineReport | null {
  const row = rowsNewestFirst[0];
  if (!row || row.truncated) return null;
  try {
    return parseSerializedBaselineReport(row.content);
  } catch {
    return null;
  }
}
