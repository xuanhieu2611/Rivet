import { z } from "zod";

import {
  benchmarkIdSchema,
  nonNegativeDecimalStringSchema,
  type BenchmarkId,
} from "./benchmark-case";
import { reviewModeSchema, type ReviewMode } from "./review-report";

/** Fields an evaluation arm may vary on a job without becoming storage-specific. */
export const evaluationJobPatchSchema = z
  .object({
    reviewMode: reviewModeSchema.optional(),
    maxReviewLoops: z.number().int().min(0).max(5).optional(),
    maxDurationSeconds: z.number().int().positive().optional(),
    maxCostUsd: nonNegativeDecimalStringSchema.optional(),
    maxModelCalls: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
  })
  .strict();

export type EvaluationJobPatch = z.infer<typeof evaluationJobPatchSchema>;

export const evaluationArmLabelSchema = z.string().trim().min(1).max(100);

export type EvaluationArmLabel = z.infer<typeof evaluationArmLabelSchema>;

/** One controlled arm in an evaluation suite. */
export const evaluationArmSchema = z
  .object({
    label: evaluationArmLabelSchema,
    jobPatch: evaluationJobPatchSchema,
  })
  .strict();

export type EvaluationArm = z.infer<typeof evaluationArmSchema>;

/**
 * A runner-facing suite definition.
 *
 * IDs, status and timestamps are persistence concerns. The runner needs only a
 * stable label, a snapshot of case ids, its controlled arms and repetition
 * count. The uniqueness checks prevent ambiguous matrix keys before a suite is
 * persisted.
 */
export const evaluationSuiteSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    arms: z.array(evaluationArmSchema).min(1),
    repetitions: z.number().int().positive().default(3),
    caseIds: z.array(benchmarkIdSchema).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const caseIds = new Set<string>();
    suite.caseIds.forEach((caseId, index) => {
      if (caseIds.has(caseId)) {
        ctx.addIssue({
          code: "custom",
          path: ["caseIds", index],
          message: "A suite cannot repeat a benchmark case.",
        });
      }
      caseIds.add(caseId);
    });

    const armLabels = new Set<string>();
    suite.arms.forEach((arm, index) => {
      if (armLabels.has(arm.label)) {
        ctx.addIssue({
          code: "custom",
          path: ["arms", index, "label"],
          message: "A suite cannot repeat an arm label.",
        });
      }
      armLabels.add(arm.label);
    });
  });

export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;

/** The small patch used by Experiment 1, exported as a convenience for callers. */
export const reviewModeArmPatchSchema = z.object({ reviewMode: reviewModeSchema }).strict();

export type ReviewModeArmPatch = z.infer<typeof reviewModeArmPatchSchema>;
export type EvaluationReviewMode = ReviewMode;
export type EvaluationCaseId = BenchmarkId;
