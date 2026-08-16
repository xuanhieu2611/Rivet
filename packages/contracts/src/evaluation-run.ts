import { z } from "zod";

import { benchmarkIdSchema, nonNegativeDecimalStringSchema } from "./benchmark-case";
import { validationOutcomeSchema, type ValidationOutcome } from "./job-event";
import { reviewDecisionSchema, type ReviewDecision } from "./review-report";
import { evaluationArmLabelSchema } from "./evaluation-suite";

/** The terminal outcomes of one evaluated job. */
export const RUN_RESULTS = ["passed", "failed", "errored", "ungraded"] as const;

export const runResultSchema = z.enum(RUN_RESULTS);

export type RunResult = z.infer<typeof runResultSchema>;

/** Human labels from PRD §24.5. */
export const FAILURE_LABELS = [
  "Incorrect diagnosis",
  "Insufficient context",
  "Bad implementation",
  "Test misunderstanding",
  "Environment failure",
  "Agent loop",
  "Budget exceeded",
  "Reviewer false positive",
  "Tool failure",
] as const;

export const failureLabelSchema = z.enum(FAILURE_LABELS);

export type FailureLabel = z.infer<typeof failureLabelSchema>;

/** Who supplied an evaluation failure label. */
export const FAILURE_LABEL_SOURCES = ["auto", "manual"] as const;

export const failureLabelSourceSchema = z.enum(FAILURE_LABEL_SOURCES);

export type FailureLabelSource = z.infer<typeof failureLabelSourceSchema>;

/**
 * A grading failure that is not one of the human taxonomy labels.
 *
 * The grader uses this for a tampered or otherwise invalid workspace. It is
 * kept separate from `failureLabelSchema` because it is a machine diagnosis,
 * not a §24.5 judgement.
 */
export const EVALUATION_FAILURE_CATEGORIES = ["grade_workspace_invalid"] as const;

export const evaluationFailureCategorySchema = z.union([
  failureLabelSchema,
  z.enum(EVALUATION_FAILURE_CATEGORIES),
]);

export type EvaluationFailureCategory = z.infer<typeof evaluationFailureCategorySchema>;

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nullableNonNegativeIntegerSchema = nonNegativeIntegerSchema.nullable();
const nullableFiniteNonNegativeNumberSchema = z.number().finite().nonnegative().nullable();

/**
 * The immutable metric snapshot written with an evaluation result.
 *
 * Nullable quality fields mean the job did not produce that source artifact;
 * zero means the source existed and contained no failures, changes or tests.
 */
export const runMetricsSchema = z
  .object({
    runtimeSeconds: nullableFiniteNonNegativeNumberSchema,
    totalModelCalls: nonNegativeIntegerSchema,
    totalToolCalls: nonNegativeIntegerSchema,
    totalTurns: nonNegativeIntegerSchema,
    totalInputTokens: nonNegativeIntegerSchema,
    totalOutputTokens: nonNegativeIntegerSchema,
    totalCostUsd: nonNegativeDecimalStringSchema,
    attemptCount: nonNegativeIntegerSchema,
    reviewLoops: nonNegativeIntegerSchema,
    reviewDecision: reviewDecisionSchema.nullable(),
    reviewBlockingCount: nullableNonNegativeIntegerSchema,
    validationOutcome: validationOutcomeSchema.nullable(),
    newFailureCount: nullableNonNegativeIntegerSchema,
    fixedFailureCount: nullableNonNegativeIntegerSchema,
    filesChanged: nullableNonNegativeIntegerSchema,
    insertions: nullableNonNegativeIntegerSchema,
    deletions: nullableNonNegativeIntegerSchema,
    hiddenTestsTotal: nullableNonNegativeIntegerSchema,
    hiddenTestsPassed: nullableNonNegativeIntegerSchema,
  })
  .strict()
  .superRefine((metrics, ctx) => {
    if ((metrics.hiddenTestsTotal === null) !== (metrics.hiddenTestsPassed === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["hiddenTestsPassed"],
        message: "Hidden test totals and passed counts must be null or present together.",
      });
    }

    if (
      metrics.hiddenTestsTotal !== null &&
      metrics.hiddenTestsPassed !== null &&
      metrics.hiddenTestsPassed > metrics.hiddenTestsTotal
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["hiddenTestsPassed"],
        message: "Hidden tests passed cannot exceed hidden tests total.",
      });
    }

    const diffStats = [metrics.filesChanged, metrics.insertions, metrics.deletions];
    if (diffStats.some((value) => value === null) && diffStats.some((value) => value !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["filesChanged"],
        message: "Diff statistics must be null or present as a complete set.",
      });
    }

    const validationCounts = [metrics.newFailureCount, metrics.fixedFailureCount];
    if (
      validationCounts.some((value) => value === null) &&
      validationCounts.some((value) => value !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["newFailureCount"],
        message: "Validation failure counts must be null or present as a complete set.",
      });
    }

    if (metrics.reviewDecision === null && metrics.reviewBlockingCount !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewBlockingCount"],
        message: "A review blocking count requires a review decision.",
      });
    }

    if (metrics.reviewDecision === "approve" && metrics.reviewBlockingCount !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewBlockingCount"],
        message: "An approved review must have zero blocking findings.",
      });
    }

    if (metrics.reviewDecision === "revise" && (metrics.reviewBlockingCount ?? 0) < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewBlockingCount"],
        message: "A revision review must have at least one blocking finding.",
      });
    }
  });

export type RunMetrics = z.infer<typeof runMetricsSchema>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hex digest.");

/**
 * A runner-facing result for one case/arm/repetition cell.
 *
 * Evaluation and job identifiers, timestamps and persistence status are left to
 * the adapter. This shape contains the reproducibility identity, grading
 * outcome, optional label and immutable metric snapshot that the runner owns.
 */
export const evaluationRunSchema = z
  .object({
    benchmarkId: benchmarkIdSchema,
    caseVersionHash: sha256Schema,
    arm: evaluationArmLabelSchema,
    repetition: z.number().int().positive(),
    result: runResultSchema,
    score: z.number().finite().min(0).max(1).nullable(),
    failureCategory: evaluationFailureCategorySchema.nullable(),
    failureLabelSource: failureLabelSourceSchema.nullable(),
    metrics: runMetricsSchema,
  })
  .strict()
  .superRefine((run, ctx) => {
    if (run.failureCategory === null && run.failureLabelSource !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["failureLabelSource"],
        message: "A failure label source requires a failure category.",
      });
    }

    if (run.failureCategory !== null && run.failureLabelSource === null) {
      ctx.addIssue({
        code: "custom",
        path: ["failureLabelSource"],
        message: "A failure category requires a failure label source.",
      });
    }

    if ((run.result === "errored" || run.result === "ungraded") && run.score !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["score"],
        message: "Errored and ungraded runs cannot have a score.",
      });
    }

    if ((run.result === "passed" || run.result === "failed") && run.score === null) {
      ctx.addIssue({
        code: "custom",
        path: ["score"],
        message: "A graded run must include a score.",
      });
    }

    if (run.result === "passed" && run.failureCategory !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["failureCategory"],
        message: "A passed run cannot have a failure category.",
      });
    }
  });

export type EvaluationRun = z.infer<typeof evaluationRunSchema>;
export type EvaluationValidationOutcome = ValidationOutcome;
export type EvaluationReviewDecision = ReviewDecision;
