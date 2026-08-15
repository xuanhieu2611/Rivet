import type { ReviewIssue, ReviewReport } from "@rivet/contracts";

import { runImplementerSession, buildAgentContext } from "./implementing-phase";
import type { PhaseContext } from "./phase-context";
import type { AgentOptions, PipelineOptions } from "./phases";
import type { PhaseDirective } from "./run-pipeline";
import { REPO_DIRNAME } from "./project";

/**
 * Phase inserted by a blocking independent review.
 *
 * This is intentionally an implementer-role session rather than a new agent
 * role. The reviewer's capabilities are read-only, while the revision needs
 * the same sandbox-backed read, write, edit and shell boundary as the original
 * implementation session. The only new input is the durable review report.
 */
export function revisingPhase(
  agent: AgentOptions,
  options: PipelineOptions,
): (ctx: PhaseContext) => Promise<PhaseDirective> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;

  return async function revise(ctx: PhaseContext): Promise<PhaseDirective> {
    ctx.signal.throwIfAborted();

    const review = await readRevisionReport(ctx);
    const baseContext = await buildAgentContext(ctx, options, repoDir, "implementer", agent);
    const context = `${baseContext}\n\n${describeRevisionBrief(review)}`;

    await runImplementerSession(agent, options, ctx, context);

    // The runner owns the cycle. A revision only changes the workspace and then
    // hands control back to deterministic validation.
    return undefined;
  };
}

async function readRevisionReport(ctx: PhaseContext): Promise<ReviewReport> {
  if (!ctx.readLatestReviewReport) {
    throw new Error("The revising phase requires a durable review report reader.");
  }

  const review = await ctx.readLatestReviewReport();
  ctx.signal.throwIfAborted();
  if (!review) {
    throw new Error("The revising phase could not find the review report that requested it.");
  }
  if (review.decision !== "revise" || review.blockingIssues.length === 0) {
    throw new Error(
      "The revising phase requires a review report with at least one blocking revision finding.",
    );
  }

  return review;
}

function describeRevisionBrief(review: ReviewReport): string {
  return [
    "# Independent review revision brief",
    "",
    "The independent reviewer found blocking issues in the current patch. Address every blocking",
    "finding below in the working tree before you finish. The implementation plan is already",
    "settled: do not re-litigate its design or broaden the change. Make the smallest evidence-based",
    "correction that resolves the findings, and add or update tests when the findings require it.",
    "",
    "## Blocking findings",
    "",
    ...describeIssues(review.blockingIssues),
    "",
    "## Non-blocking findings",
    "",
    ...(review.nonBlockingIssues.length === 0
      ? ["No non-blocking findings were reported."]
      : describeIssues(review.nonBlockingIssues)),
    "",
    `Reviewer summary: ${review.summary}`,
    "",
    "When the corrections are complete, verify the changed behavior and end with a concise",
    "summary of what you addressed. Do not discard the existing patch and start over.",
  ].join("\n");
}

function describeIssues(issues: readonly ReviewIssue[]): string[] {
  return issues.flatMap((issue) => [
    `- ${issue.title} [${issue.category}]${describePaths(issue.paths)}`,
    `  ${issue.detail}`,
  ]);
}

function describePaths(paths: readonly string[]): string {
  return paths.length === 0 ? "" : ` (${paths.join(", ")})`;
}
