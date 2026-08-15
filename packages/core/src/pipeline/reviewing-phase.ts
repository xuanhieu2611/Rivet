import { parseReviewReport, serializeReviewReport, type ReviewReport } from "@rivet/contracts";

import { ReviewNotProducedError, ReviewerRejectionError } from "../agent/errors";
import type { CodingAgentSpec, ReviewerAgentToolbox } from "../agent/coding-agent";
import { commandKilledError } from "../sandbox/errors";
import { buildAgentContext, parseCostCeiling } from "./implementing-phase";
import { runAgentSession } from "./agent-session";
import type { PhaseContext } from "./phase-context";
import type { AgentOptions, Phase, PipelineOptions } from "./phases";
import type { PhaseDirective } from "./run-pipeline";
import { REPO_DIRNAME } from "./project";

/**
 * The phases a blocking verdict may insert before the remaining queue.
 *
 * `revising` is intentionally not part of the base template. The runner knows
 * this phase through its directive-reachable set, and the reviewing phase gets
 * the exact objects the pipeline configured so identity validation remains
 * meaningful.
 */
export interface ReviewCyclePhases {
  revising: Phase;
  testing: Phase;
  reviewing: Phase;
}

/**
 * The independent review phase.
 *
 * The reviewer is a fresh, read-only session. Its only write-like capability is
 * `submit_review`, which validates the structured verdict and hands it back to
 * this phase. The patch is never exposed to a shell or an edit tool after
 * validation, so the thing being judged cannot change underneath the verdict.
 */
export function reviewingPhase(
  agent: AgentOptions,
  options: PipelineOptions,
  cycle?: ReviewCyclePhases,
): (ctx: PhaseContext) => Promise<PhaseDirective> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;

  return async function review(ctx: PhaseContext): Promise<PhaseDirective> {
    ctx.signal.throwIfAborted();

    if (ctx.job.reviewMode === "none") {
      await ctx.event({
        type: "review.skipped",
        message: "Independent review skipped by the job.",
        data: { reviewMode: "none" },
      });
      return undefined;
    }

    const sandbox = ctx.sandboxes.require();
    let submittedReview: ReviewReport | undefined;

    const toolbox: ReviewerAgentToolbox = {
      role: "reviewer",
      listFiles: (signal) =>
        runReadOnlyCommand(ctx, options, repoDir, ["git", "ls-files"], signal, agent.fileMaxBytes),
      readFile: (path, signal) => sandbox.getFile(path, { maxBytes: agent.fileMaxBytes }, signal),
      searchText: (query, signal) => {
        if (query.trim().length === 0) {
          return Promise.reject(new Error("search_text requires a non-empty query."));
        }
        return runReadOnlyCommand(
          ctx,
          options,
          repoDir,
          ["git", "grep", "-n", "--no-color", "-e", query, "--", "."],
          signal,
          agent.fileMaxBytes,
        );
      },
      submitReview: (value, signal) => {
        signal.throwIfAborted();
        if (submittedReview !== undefined) {
          return Promise.reject(new Error("A review session may submit only one review verdict."));
        }
        submittedReview = parseReviewReport(value);
        return Promise.resolve();
      },
    };

    const spec: CodingAgentSpec = {
      role: "reviewer",
      workdir: repoDir,
      task: { title: ctx.job.title, description: ctx.job.description },
      context: await buildAgentContext(ctx, options, repoDir, "reviewer", agent),
      sessionTimeoutMs: agent.sessionTimeoutMs,
      commandTimeoutMs: options.commandTimeoutMs,
      previewMaxBytes: agent.previewMaxBytes,
      limits: {
        maxTurns: agent.maxTurns,
        maxToolCalls: ctx.job.maxToolCalls,
        maxModelCalls: ctx.job.maxModelCalls,
        maxCostUsd: parseCostCeiling(ctx.job.maxCostUsd),
      },
    };

    await runAgentSession(agent, spec, toolbox, ctx);
    ctx.signal.throwIfAborted();

    if (submittedReview === undefined) {
      throw new ReviewNotProducedError(
        "The review session ended without a valid submit_review call. A JSON assistant message is not a persisted review verdict.",
      );
    }

    const review = submittedReview;
    const reviewLoop = validNonnegativeInteger(ctx.job.reviewLoops, 0);
    const maxReviewLoops = validNonnegativeInteger(ctx.job.maxReviewLoops, 2);
    const blockingCount = review.blockingIssues.length;
    const nonBlockingCount = review.nonBlockingIssues.length;

    const artifactId = await ctx.artifact({
      type: "review_report",
      content: serializeReviewReport(review),
      requireComplete: true,
      message: "Review report artifact recorded.",
    });

    await ctx.event({
      type: "review.recorded",
      message: `Review ${review.decision} verdict recorded.`,
      data: {
        artifactId,
        artifactType: "review_report",
        agentRole: "reviewer",
        reviewDecision: review.decision,
        reviewLoop,
        blockingCount,
        nonBlockingCount,
        confidence: review.confidence,
      },
    });

    if (review.decision === "approve") {
      await recordReview(ctx, {
        reviewDecision: review.decision,
        reviewLoops: reviewLoop,
        reviewBlockingCount: blockingCount,
      });
      return undefined;
    }

    if (reviewLoop < maxReviewLoops) {
      const reviewLoops = reviewLoop + 1;
      await recordReview(ctx, {
        reviewDecision: review.decision,
        reviewLoops,
        reviewBlockingCount: blockingCount,
      });
      await ctx.event({
        type: "review.revision_requested",
        message: `Review requested a revision (${reviewLoops}/${maxReviewLoops}).`,
        data: {
          reviewLoop,
          reviewLoops,
          maxReviewLoops,
          blockingCount,
        },
      });

      if (!cycle) {
        throw new Error(
          "The reviewer requested a revision, but the pipeline did not configure cycle phases.",
        );
      }

      return {
        kind: "cycle",
        phases: [cycle.revising, cycle.testing, cycle.reviewing],
      };
    }

    await recordReview(ctx, {
      reviewDecision: review.decision,
      reviewLoops: reviewLoop,
      reviewBlockingCount: blockingCount,
    });
    await ctx.event({
      type: "review.limit_reached",
      message: `Review limit reached with ${blockingCount} blocking finding${blockingCount === 1 ? "" : "s"}.`,
      data: {
        reviewLoops: reviewLoop,
        maxReviewLoops,
        blockingCount,
        failureCategory: "reviewer_rejection",
      },
    });

    throw new ReviewerRejectionError(
      `The reviewer still found ${blockingCount} blocking issue${blockingCount === 1 ? "" : "s"} after ${reviewLoop} revision loop${reviewLoop === 1 ? "" : "s"}. ${review.summary}`,
      { blockingCount, reviewLoops: reviewLoop, maxReviewLoops },
    );
  };
}

async function recordReview(
  ctx: PhaseContext,
  patch: Parameters<NonNullable<PhaseContext["recordReview"]>>[0],
): Promise<void> {
  if (!ctx.recordReview) {
    throw new Error("The reviewing phase requires a lease-fenced recordReview capability.");
  }

  await ctx.recordReview(patch);
  // Keep focused phase harnesses and the production context equally safe when
  // the runner immediately enters another reviewing phase in the same attempt.
  ctx.job.reviewDecision = patch.reviewDecision ?? ctx.job.reviewDecision;
  ctx.job.reviewLoops = patch.reviewLoops ?? ctx.job.reviewLoops;
  ctx.job.reviewBlockingCount =
    patch.reviewBlockingCount === undefined
      ? ctx.job.reviewBlockingCount
      : patch.reviewBlockingCount;
}

async function runReadOnlyCommand(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
  argv: string[],
  signal: AbortSignal,
  maxOutputBytes: number,
): Promise<string> {
  signal.throwIfAborted();
  const result = await ctx.exec({
    argv,
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes,
  });
  ctx.signal.throwIfAborted();
  const killed = commandKilledError(result);
  if (killed) throw killed;
  return result.stdout;
}

function validNonnegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
