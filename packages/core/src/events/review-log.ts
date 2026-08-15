import { parseSerializedReviewReport, type ReviewReport } from "@rivet/contracts";
import { db, type Executor, jobArtifacts } from "@rivet/database";
import { and, desc, eq } from "drizzle-orm";

/** The newest review artifact is the previous verdict for the next loop. */
export interface ReviewReportArtifactLike {
  content: string;
  truncated: boolean;
}

/**
 * Parses the newest review report when it is complete and valid.
 *
 * A malformed newest report is not replaced with an older verdict. The latest
 * row is the authoritative record of what the previous review produced, and a
 * missing trusted value is more honest context than silently showing an older
 * opinion.
 */
export function reviewReportFrom(
  rowsNewestFirst: readonly ReviewReportArtifactLike[],
): ReviewReport | null {
  const row = rowsNewestFirst[0];
  if (!row || row.truncated) return null;

  try {
    return parseSerializedReviewReport(row.content);
  } catch {
    return null;
  }
}

/** Reads the newest complete structured review report for a job. */
export async function readLatestReviewReport(
  jobId: string,
  executor: Executor = db,
): Promise<ReviewReport | null> {
  const [row] = await executor
    .select({ content: jobArtifacts.content, truncated: jobArtifacts.truncated })
    .from(jobArtifacts)
    .where(and(eq(jobArtifacts.jobId, jobId), eq(jobArtifacts.type, "review_report")))
    .orderBy(desc(jobArtifacts.id))
    .limit(1);

  return reviewReportFrom(row ? [row] : []);
}
