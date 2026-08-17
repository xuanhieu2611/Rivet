import type { EvaluationRunRow, Executor, NewEvaluationRunRow } from "@rivet/database";
import { describe, expect, it } from "vitest";

import {
  createEvaluationRun,
  labelEvaluationRun,
  listEvaluationRunsByBenchmark,
  toEvaluationRun,
  updateEvaluationRunGrade,
} from "./run-store";

const SUITE_ID = "11111111-2222-3333-4444-555555555555";
const JOB_ID = "22222222-3333-4444-5555-666666666666";
const RUN_ID = "33333333-4444-5555-6666-777777777777";
const VERSION_HASH = "a".repeat(64);

const METRICS = {
  runtimeSeconds: 4.5,
  totalModelCalls: 2,
  totalToolCalls: 8,
  totalTurns: 2,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  totalCostUsd: "0.25",
  attemptCount: 1,
  reviewLoops: 0,
  reviewDecision: "approve" as const,
  reviewBlockingCount: 0,
  validationOutcome: "verified" as const,
  newFailureCount: 0,
  fixedFailureCount: 0,
  filesChanged: 1,
  insertions: 2,
  deletions: 0,
  hiddenTestsTotal: 2,
  hiddenTestsPassed: 2,
};

const RUN = {
  benchmarkId: "bulk-discount-boundary",
  caseVersionHash: VERSION_HASH,
  arm: "independent",
  repetition: 1,
  result: "passed" as const,
  score: 1,
  failureCategory: null,
  failureLabelSource: null,
  metrics: METRICS,
};

function rowFrom(values: NewEvaluationRunRow): EvaluationRunRow {
  return {
    id: RUN_ID,
    score: null,
    failureCategory: null,
    failureLabelSource: null,
    gradedAt: new Date(0),
    createdAt: new Date(0),
    ...values,
  } as EvaluationRunRow;
}

function capturingExecutor(initial?: EvaluationRunRow) {
  let current = initial;
  const inserted: NewEvaluationRunRow[] = [];
  const updates: Record<string, unknown>[] = [];
  const executor = {
    insert: () => ({
      values: (value: NewEvaluationRunRow) => {
        inserted.push(value);
        current = rowFrom(value);
        return { returning: () => Promise.resolve(current ? [current] : []) };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(current ? [current] : []),
          orderBy: () => Promise.resolve(current ? [current] : []),
        }),
        orderBy: () => Promise.resolve(current ? [current] : []),
      }),
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => {
        updates.push(value);
        current = current ? { ...current, ...value } : undefined;
        return {
          where: () => ({ returning: () => Promise.resolve(current ? [current] : []) }),
        };
      },
    }),
  } as unknown as Executor;

  return { executor, inserted, updates };
}

describe("createEvaluationRun", () => {
  it("validates the result and stores its metric snapshot", async () => {
    const capture = capturingExecutor();
    const gradedAt = new Date("2020-01-01T00:00:00Z");

    const stored = await createEvaluationRun(
      { ...RUN, suiteId: SUITE_ID, jobId: JOB_ID, gradedAt },
      capture.executor,
    );

    expect(capture.inserted).toEqual([
      {
        suiteId: SUITE_ID,
        benchmarkId: RUN.benchmarkId,
        caseVersionHash: VERSION_HASH,
        arm: RUN.arm,
        repetition: 1,
        jobId: JOB_ID,
        result: "passed",
        score: "1",
        failureCategory: null,
        failureLabelSource: null,
        metricsJson: METRICS,
        gradedAt,
      },
    ]);
    expect(stored).toEqual({
      ...RUN,
      id: RUN_ID,
      suiteId: SUITE_ID,
      jobId: JOB_ID,
      gradedAt,
      createdAt: new Date(0),
    });
  });

  it("rejects a result whose score and label fields contradict it", async () => {
    const capture = capturingExecutor();

    await expect(
      createEvaluationRun(
        {
          ...RUN,
          suiteId: SUITE_ID,
          result: "errored",
          score: 0,
        },
        capture.executor,
      ),
    ).rejects.toThrow(/cannot have a score/);
    expect(capture.inserted).toHaveLength(0);
  });
});

describe("updateEvaluationRunGrade", () => {
  it("updates the grade snapshot without touching the job reference", async () => {
    const initial = rowFrom({
      suiteId: SUITE_ID,
      benchmarkId: RUN.benchmarkId,
      caseVersionHash: VERSION_HASH,
      arm: RUN.arm,
      repetition: RUN.repetition,
      jobId: JOB_ID,
      result: "failed",
      score: "0.5000",
      failureCategory: null,
      failureLabelSource: null,
      metricsJson: METRICS,
      gradedAt: new Date(0),
    });
    const capture = capturingExecutor(initial);
    const nextMetrics = { ...METRICS, hiddenTestsPassed: 2 };

    const updated = await updateEvaluationRunGrade(
      {
        id: RUN_ID,
        caseVersionHash: "b".repeat(64),
        result: "passed",
        score: 1,
        failureCategory: null,
        failureLabelSource: null,
        metrics: nextMetrics,
        gradedAt: new Date("2026-01-01T00:00:00Z"),
      },
      capture.executor,
    );

    expect(capture.updates).toEqual([
      {
        caseVersionHash: "b".repeat(64),
        result: "passed",
        score: "1",
        failureCategory: null,
        failureLabelSource: null,
        metricsJson: nextMetrics,
        gradedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    expect(updated?.jobId).toBe(JOB_ID);
    expect(updated?.result).toBe("passed");
  });
});

describe("labelEvaluationRun", () => {
  it("updates only the label columns", async () => {
    const initial = rowFrom({
      suiteId: SUITE_ID,
      benchmarkId: RUN.benchmarkId,
      caseVersionHash: VERSION_HASH,
      arm: RUN.arm,
      repetition: RUN.repetition,
      jobId: JOB_ID,
      result: "failed",
      score: "0.5000",
      failureCategory: null,
      failureLabelSource: null,
      metricsJson: METRICS,
      gradedAt: new Date(0),
    });
    const capture = capturingExecutor(initial);

    const labeled = await labelEvaluationRun(
      {
        id: RUN_ID,
        failureCategory: "Bad implementation",
        failureLabelSource: "manual",
      },
      capture.executor,
    );

    expect(capture.updates).toEqual([
      { failureCategory: "Bad implementation", failureLabelSource: "manual" },
    ]);
    expect(labeled?.failureCategory).toBe("Bad implementation");
    expect(labeled?.failureLabelSource).toBe("manual");
    expect(labeled?.score).toBe(0.5);
  });

  it("requires a source whenever a label is present", async () => {
    const capture = capturingExecutor();

    await expect(
      labelEvaluationRun(
        { id: RUN_ID, failureCategory: "Tool failure", failureLabelSource: null },
        capture.executor,
      ),
    ).rejects.toThrow(/requires a failure label source/);
  });
});

describe("toEvaluationRun", () => {
  it("rejects a corrupt numeric score", () => {
    expect(() =>
      toEvaluationRun(
        rowFrom({
          suiteId: SUITE_ID,
          benchmarkId: RUN.benchmarkId,
          caseVersionHash: VERSION_HASH,
          arm: RUN.arm,
          repetition: RUN.repetition,
          jobId: JOB_ID,
          result: "passed",
          score: "2.0000",
          failureCategory: null,
          failureLabelSource: null,
          metricsJson: METRICS,
          gradedAt: new Date(0),
        }),
      ),
    ).toThrow();
  });
});

describe("listEvaluationRunsByBenchmark", () => {
  it("returns a case's runs across suites", async () => {
    const capture = capturingExecutor(
      rowFrom({
        suiteId: SUITE_ID,
        benchmarkId: RUN.benchmarkId,
        caseVersionHash: VERSION_HASH,
        arm: RUN.arm,
        repetition: RUN.repetition,
        jobId: JOB_ID,
        result: "passed",
        score: "1",
        failureCategory: null,
        failureLabelSource: null,
        metricsJson: METRICS,
        gradedAt: new Date(0),
      }),
    );

    const runs = await listEvaluationRunsByBenchmark(RUN.benchmarkId, capture.executor);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ benchmarkId: RUN.benchmarkId, suiteId: SUITE_ID });
  });

  it("refuses an id the benchmark scheme cannot express instead of querying", async () => {
    const capture = capturingExecutor();

    expect(await listEvaluationRunsByBenchmark("../../etc", capture.executor)).toEqual([]);
  });
});
