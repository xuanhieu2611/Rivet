import { describe, expect, it } from "vitest";

import {
  EVALUATION_FAILURE_CATEGORIES,
  FAILURE_LABELS,
  evaluationFailureCategorySchema,
  evaluationRunSchema,
  failureLabelSchema,
  runMetricsSchema,
  runResultSchema,
  RUN_RESULTS,
} from "./evaluation-run";

const VALID_METRICS = {
  runtimeSeconds: 12.5,
  totalModelCalls: 4,
  totalToolCalls: 16,
  totalTurns: 5,
  totalInputTokens: 1_200,
  totalOutputTokens: 350,
  totalCostUsd: "0.1250",
  attemptCount: 1,
  reviewLoops: 0,
  reviewDecision: "approve",
  reviewBlockingCount: 0,
  validationOutcome: "verified",
  newFailureCount: 0,
  fixedFailureCount: 1,
  filesChanged: 2,
  insertions: 8,
  deletions: 3,
  hiddenTestsTotal: 4,
  hiddenTestsPassed: 4,
} as const;

const VALID_RUN = {
  benchmarkId: "bulk-discount-boundary",
  caseVersionHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  arm: "independent",
  repetition: 1,
  result: "passed",
  score: 1,
  failureCategory: null,
  failureLabelSource: null,
  metrics: VALID_METRICS,
} as const;

describe("runResultSchema", () => {
  it("accepts exactly the four terminal evaluation results", () => {
    for (const result of RUN_RESULTS) expect(runResultSchema.parse(result)).toBe(result);
    expect(runResultSchema.safeParse("completed").success).toBe(false);
  });
});

describe("failure labels", () => {
  it("accepts the complete PRD taxonomy and the grader category", () => {
    for (const label of FAILURE_LABELS) expect(failureLabelSchema.parse(label)).toBe(label);
    for (const category of EVALUATION_FAILURE_CATEGORIES) {
      expect(evaluationFailureCategorySchema.parse(category)).toBe(category);
    }
    expect(failureLabelSchema.safeParse("grade_workspace_invalid").success).toBe(false);
    expect(failureLabelSchema.safeParse("Other failure").success).toBe(false);
  });
});

describe("runMetricsSchema", () => {
  it("accepts the complete immutable metric snapshot", () => {
    expect(runMetricsSchema.parse(VALID_METRICS)).toEqual(VALID_METRICS);
  });

  it("accepts null source metrics when a job produced no corresponding artifact", () => {
    expect(
      runMetricsSchema.parse({
        runtimeSeconds: null,
        totalModelCalls: 0,
        totalToolCalls: 0,
        totalTurns: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: "0.0000",
        attemptCount: 1,
        reviewLoops: 0,
        reviewDecision: null,
        reviewBlockingCount: null,
        validationOutcome: null,
        newFailureCount: null,
        fixedFailureCount: null,
        filesChanged: null,
        insertions: null,
        deletions: null,
        hiddenTestsTotal: null,
        hiddenTestsPassed: null,
      }),
    ).toMatchObject({ runtimeSeconds: null, validationOutcome: null });
  });

  it("rejects unknown fields and inconsistent nested totals", () => {
    expect(runMetricsSchema.safeParse({ ...VALID_METRICS, unexpected: 1 }).success).toBe(false);
    expect(runMetricsSchema.safeParse({ ...VALID_METRICS, hiddenTestsPassed: 5 }).success).toBe(
      false,
    );
    expect(runMetricsSchema.safeParse({ ...VALID_METRICS, hiddenTestsTotal: null }).success).toBe(
      false,
    );
    expect(runMetricsSchema.safeParse({ ...VALID_METRICS, filesChanged: null }).success).toBe(
      false,
    );
    expect(runMetricsSchema.safeParse({ ...VALID_METRICS, reviewDecision: null }).success).toBe(
      false,
    );
  });
});

describe("evaluationRunSchema", () => {
  it("accepts a graded runner result without persistence fields", () => {
    expect(evaluationRunSchema.parse(VALID_RUN)).toEqual(VALID_RUN);
  });

  it("accepts an ungraded result with no score and an automatic grading category", () => {
    expect(
      evaluationRunSchema.parse({
        ...VALID_RUN,
        result: "ungraded",
        score: null,
        failureCategory: "grade_workspace_invalid",
        failureLabelSource: "auto",
      }),
    ).toMatchObject({ result: "ungraded", score: null });
  });

  it("rejects unknown fields, invalid hashes, and invalid result-score pairs", () => {
    expect(evaluationRunSchema.safeParse({ ...VALID_RUN, id: "persisted-id" }).success).toBe(false);
    expect(
      evaluationRunSchema.safeParse({ ...VALID_RUN, caseVersionHash: "not-a-sha" }).success,
    ).toBe(false);
    expect(
      evaluationRunSchema.safeParse({ ...VALID_RUN, result: "errored", score: 0 }).success,
    ).toBe(false);
    expect(
      evaluationRunSchema.safeParse({ ...VALID_RUN, result: "failed", score: null }).success,
    ).toBe(false);
  });

  it("requires a source whenever a failure category is present", () => {
    expect(
      evaluationRunSchema.safeParse({
        ...VALID_RUN,
        result: "failed",
        score: 0.5,
        failureCategory: "Bad implementation",
        failureLabelSource: null,
      }).success,
    ).toBe(false);
    expect(
      evaluationRunSchema.safeParse({
        ...VALID_RUN,
        failureCategory: null,
        failureLabelSource: "auto",
      }).success,
    ).toBe(false);
  });
});
