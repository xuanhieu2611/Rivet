import type { RunMetrics } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  countEvaluationOutcomes,
  summarizeEvaluationEfficiency,
  summarizeEvaluationFailures,
  summarizeEvaluationQuality,
  summarizeEvaluationRuns,
  UNCATEGORIZED_KEY,
  type AggregatableEvaluationRun,
} from "./aggregate";

function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runtimeSeconds: 60,
    totalModelCalls: 4,
    totalToolCalls: 9,
    totalTurns: 3,
    totalInputTokens: 1_000,
    totalOutputTokens: 200,
    totalCostUsd: "0.1000",
    attemptCount: 1,
    reviewLoops: 0,
    reviewDecision: null,
    reviewBlockingCount: null,
    validationOutcome: "verified",
    newFailureCount: 0,
    fixedFailureCount: 0,
    filesChanged: 2,
    insertions: 10,
    deletions: 4,
    hiddenTestsTotal: 4,
    hiddenTestsPassed: 4,
    ...overrides,
  };
}

function run(overrides: Partial<AggregatableEvaluationRun> = {}): AggregatableEvaluationRun {
  return {
    benchmarkId: "bulk-discount-boundary",
    arm: "independent",
    repetition: 1,
    result: "passed",
    score: 1,
    failureCategory: null,
    failureLabelSource: null,
    metrics: metrics(),
    ...overrides,
  };
}

describe("countEvaluationOutcomes", () => {
  it("excludes errored and ungraded runs from the success denominator", () => {
    const counts = countEvaluationOutcomes([
      run({ result: "passed", score: 1 }),
      run({ result: "failed", score: 0.5, failureCategory: null, failureLabelSource: null }),
      run({ result: "errored", score: null }),
      run({ result: "ungraded", score: null }),
    ]);

    expect(counts).toMatchObject({
      passed: 1,
      failed: 1,
      errored: 1,
      ungraded: 1,
      total: 4,
      graded: 2,
    });
    expect(counts.successRate).toBe(0.5);
  });

  it("reports no success rate rather than zero when nothing could be graded", () => {
    const counts = countEvaluationOutcomes([
      run({ result: "errored", score: null }),
      run({ result: "ungraded", score: null }),
    ]);

    expect(counts.graded).toBe(0);
    expect(counts.successRate).toBeNull();
    expect(counts.total).toBe(2);
  });

  it("counts nothing as nothing", () => {
    expect(countEvaluationOutcomes([])).toMatchObject({ total: 0, successRate: null });
  });
});

describe("summarizeEvaluationRuns", () => {
  const suite: AggregatableEvaluationRun[] = [
    run({ benchmarkId: "alpha", arm: "independent", repetition: 1, result: "passed", score: 1 }),
    run({ benchmarkId: "alpha", arm: "independent", repetition: 2, result: "failed", score: 0.25 }),
    run({ benchmarkId: "alpha", arm: "none", repetition: 1, result: "failed", score: 0 }),
    run({ benchmarkId: "alpha", arm: "none", repetition: 2, result: "failed", score: 0 }),
    run({ benchmarkId: "beta", arm: "independent", repetition: 1, result: "passed", score: 1 }),
    run({ benchmarkId: "beta", arm: "independent", repetition: 2, result: "errored", score: null }),
    run({ benchmarkId: "beta", arm: "none", repetition: 1, result: "passed", score: 1 }),
    run({ benchmarkId: "beta", arm: "none", repetition: 2, result: "ungraded", score: null }),
  ].map((value) =>
    value.result === "passed"
      ? value
      : { ...value, failureCategory: null, failureLabelSource: null },
  );

  it("matches a hand-computed table for a two-case, two-arm, two-repetition suite", () => {
    const summary = summarizeEvaluationRuns(suite);

    // 3 passed, 3 failed, 1 errored, 1 ungraded: 3/6 graded.
    expect(summary.overall).toMatchObject({
      passed: 3,
      failed: 3,
      errored: 1,
      ungraded: 1,
      graded: 6,
      total: 8,
    });
    expect(summary.overall.successRate).toBe(0.5);

    expect(summary.byArm.map((arm) => [arm.key, arm.counts.successRate])).toEqual([
      ["independent", 2 / 3],
      ["none", 1 / 3],
    ]);
    expect(summary.byCase.map((entry) => [entry.key, entry.counts.successRate])).toEqual([
      ["alpha", 0.25],
      ["beta", 1],
    ]);
  });

  it("keeps the per-cell repetition spread instead of flattening it to a boolean", () => {
    const summary = summarizeEvaluationRuns(suite);
    const cell = summary.matrix.find(
      (entry) => entry.benchmarkId === "alpha" && entry.arm === "independent",
    );

    expect(cell?.counts).toMatchObject({ passed: 1, graded: 2, total: 2 });
    expect(cell?.scores).toEqual([1, 0.25]);
    expect(cell?.minScore).toBe(0.25);
    expect(cell?.maxScore).toBe(1);
  });

  it("orders arms by first appearance and cases by id", () => {
    const summary = summarizeEvaluationRuns([
      run({ benchmarkId: "zeta", arm: "none" }),
      run({ benchmarkId: "alpha", arm: "independent" }),
    ]);

    expect(summary.arms).toEqual(["none", "independent"]);
    expect(summary.benchmarkIds).toEqual(["alpha", "zeta"]);
    expect(summary.matrix.map((cell) => [cell.benchmarkId, cell.arm])).toEqual([
      ["alpha", "independent"],
      ["zeta", "none"],
    ]);
  });

  it("groups by case category and buckets cases missing from the registry", () => {
    const summary = summarizeEvaluationRuns(
      [
        run({ benchmarkId: "alpha", result: "passed", score: 1 }),
        run({ benchmarkId: "beta", result: "failed", score: 0 }),
        run({ benchmarkId: "gamma", result: "passed", score: 1 }),
      ],
      { categories: { alpha: "bug_fix", beta: "bug_fix" } },
    );

    expect(summary.byCategory.map((entry) => [entry.key, entry.counts.successRate])).toEqual([
      ["bug_fix", 0.5],
      [UNCATEGORIZED_KEY, 1],
    ]);
  });

  it("counts non-passing runs that carry no label", () => {
    const summary = summarizeEvaluationRuns([
      run({ result: "failed", score: 0 }),
      run({
        result: "failed",
        score: 0,
        failureCategory: "Bad implementation",
        failureLabelSource: "manual",
      }),
      run({ result: "passed", score: 1 }),
    ]);

    expect(summary.unlabeledFailures).toBe(1);
  });
});

describe("summarizeEvaluationEfficiency", () => {
  it("medians runtime across an even sample and sums cost to four decimals", () => {
    const efficiency = summarizeEvaluationEfficiency([
      run({ metrics: metrics({ runtimeSeconds: 10, totalCostUsd: "0.0500" }) }),
      run({ metrics: metrics({ runtimeSeconds: 20, totalCostUsd: "0.2500" }) }),
      run({ metrics: metrics({ runtimeSeconds: 30, totalCostUsd: "0.1000" }) }),
      run({ metrics: metrics({ runtimeSeconds: 100, totalCostUsd: "0.1000" }) }),
    ]);

    expect(efficiency.medianRuntimeSeconds).toBe(25);
    expect(efficiency.meanRuntimeSeconds).toBe(40);
    expect(efficiency.totalCostUsd).toBe("0.5000");
    expect(efficiency.meanCostUsd).toBe("0.1250");
    expect(efficiency.totalModelCalls).toBe(16);
  });

  it("reports no runtime when no run recorded one", () => {
    const efficiency = summarizeEvaluationEfficiency([
      run({ metrics: metrics({ runtimeSeconds: null }) }),
    ]);

    expect(efficiency.medianRuntimeSeconds).toBeNull();
    expect(efficiency.meanRuntimeSeconds).toBeNull();
    expect(efficiency.totalCostUsd).toBe("0.1000");
  });
});

describe("summarizeEvaluationQuality", () => {
  it("skips absent artifacts rather than averaging them in as zero", () => {
    const quality = summarizeEvaluationQuality([
      run({ metrics: metrics({ filesChanged: 4, insertions: 40, deletions: 0 }) }),
      run({ metrics: metrics({ filesChanged: null, insertions: null, deletions: null }) }),
    ]);

    expect(quality.meanFilesChanged).toBe(4);
    expect(quality.meanInsertions).toBe(40);
  });

  it("counts regressions and review decisions", () => {
    const quality = summarizeEvaluationQuality([
      run({
        metrics: metrics({
          validationOutcome: "regressed",
          newFailureCount: 2,
          reviewDecision: "revise",
          reviewBlockingCount: 3,
          reviewLoops: 2,
        }),
      }),
      run({
        metrics: metrics({ reviewDecision: "approve", reviewBlockingCount: 0, reviewLoops: 1 }),
      }),
      run({ metrics: metrics() }),
    ]);

    expect(quality).toMatchObject({
      regressedRuns: 1,
      newFailureTotal: 2,
      reviewApproved: 1,
      reviewRevised: 1,
      reviewAbsent: 1,
      meanReviewLoops: 1.5,
    });
  });
});

describe("summarizeEvaluationFailures", () => {
  it("builds a histogram over non-passing runs with an unlabelled bucket", () => {
    const buckets = summarizeEvaluationFailures([
      run({ result: "passed", score: 1 }),
      run({
        result: "errored",
        score: null,
        failureCategory: "Environment failure",
        failureLabelSource: "auto",
      }),
      run({
        result: "errored",
        score: null,
        failureCategory: "Environment failure",
        failureLabelSource: "auto",
      }),
      run({
        result: "ungraded",
        score: null,
        failureCategory: "grade_workspace_invalid",
        failureLabelSource: "auto",
      }),
      run({ result: "failed", score: 0 }),
    ]);

    expect(buckets).toEqual([
      { label: "Environment failure", auto: 2, manual: 0, total: 2 },
      { label: "grade_workspace_invalid", auto: 1, manual: 0, total: 1 },
      { label: null, auto: 0, manual: 0, total: 1 },
    ]);
  });

  it("separates auto labels from human ones in the same bucket", () => {
    const buckets = summarizeEvaluationFailures([
      run({
        result: "failed",
        score: 0,
        failureCategory: "Bad implementation",
        failureLabelSource: "manual",
      }),
      run({
        result: "failed",
        score: 0,
        failureCategory: "Bad implementation",
        failureLabelSource: "auto",
      }),
    ]);

    expect(buckets).toEqual([{ label: "Bad implementation", auto: 1, manual: 1, total: 2 }]);
  });

  it("emits no buckets when nothing failed", () => {
    expect(summarizeEvaluationFailures([run({ result: "passed", score: 1 })])).toEqual([]);
  });
});
