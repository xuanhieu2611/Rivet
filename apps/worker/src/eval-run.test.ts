import { describe, expect, it } from "vitest";

import type { JobDetail, ValidationReport } from "@rivet/contracts";

import {
  buildEvaluationMatrix,
  buildMetrics,
  formatEvaluationMatrix,
  type PreparedEvaluationCase,
  waitForTerminal,
} from "./eval-run";

const VERSION_HASH = "a".repeat(64);
const BASE_COMMIT = "b".repeat(40);

function benchmark(id: string): PreparedEvaluationCase {
  return {
    id,
    directory: `/benchmarks/${id}`,
    repoDirectory: `/benchmarks/${id}/repo`,
    hiddenDirectory: `/benchmarks/${id}/hidden`,
    spec: {
      id,
      title: `Fix ${id}`,
      category: "bug_fix",
      difficulty: 1,
      issue: `Fix ${id}.`,
      setupCommand: null,
      validationCommand: ["node", "--test", "hidden/"],
      expectedBehavior: "The hidden boundary behaves correctly.",
      reviewMode: "independent",
      maxCostUsd: "1.00",
      maxDurationSeconds: 900,
      commit: {
        author: "Rivet Tests",
        email: "tests@example.com",
        date: "2020-01-01T00:00:00Z",
      },
    },
    versionHash: VERSION_HASH,
    lock: { versionHash: VERSION_HASH, baseCommitSha: BASE_COMMIT },
    hiddenFiles: [],
  };
}

function job(overrides: Partial<JobDetail> = {}): JobDetail {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "11111111-2222-3333-4444-555555555555",
    title: "Benchmark job",
    repoUrl: "rivet-local:fixture",
    baseBranch: "main",
    status: "completed",
    createdAt: startedAt,
    updatedAt: new Date("2026-01-01T00:00:06.000Z"),
    description: "Run the benchmark.",
    baseCommitSha: BASE_COMMIT,
    traceContext: null,
    githubInstallationId: null,
    repoOwner: null,
    repoName: null,
    issueNumber: null,
    issueUrl: null,
    envFingerprint: null,
    priority: 0,
    maxDurationSeconds: 900,
    maxCostUsd: "1.00",
    maxModelCalls: 200,
    maxToolCalls: 500,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: "0.1234",
    totalTurns: 3,
    totalModelCalls: 4,
    totalToolCalls: 5,
    startedAt,
    deadlineAt: new Date("2026-01-01T00:15:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:05.600Z"),
    finalBranch: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    failureReason: null,
    dispatchGeneration: 0,
    attemptCount: 2,
    failureCategory: null,
    cancelRequestedAt: null,
    leaseExpiresAt: null,
    reviewMode: "independent",
    maxReviewLoops: 2,
    reviewLoops: 1,
    reviewDecision: "approve",
    reviewBlockingCount: 0,
    ...overrides,
  };
}

const validationReport: ValidationReport = {
  outcome: "regressed",
  checks: [
    {
      kind: "targeted_test",
      status: "passed",
      source: "package_json",
      argv: ["node", "--test"],
      exitCode: 0,
      durationMs: 1,
      baseline: "passed",
      outcome: "verified",
      attribution: {
        newFailures: ["targeted"],
        preExistingFailures: [],
        fixedFailures: [],
      },
    },
    {
      kind: "test",
      status: "failed",
      source: "package_json",
      argv: ["node", "--test"],
      exitCode: 1,
      durationMs: 1,
      baseline: "passed",
      outcome: "regressed",
      attribution: {
        newFailures: ["test-a", "test-b"],
        preExistingFailures: [],
        fixedFailures: ["test-c"],
      },
    },
  ],
};

describe("evaluation matrix", () => {
  it("expands cases, arms and repetitions in stable order", () => {
    const suite = {
      label: "test",
      arms: [
        { label: "independent", jobPatch: { reviewMode: "independent" as const } },
        { label: "none", jobPatch: { reviewMode: "none" as const } },
      ],
      repetitions: 2,
      caseIds: ["first", "second"],
    };

    const cells = buildEvaluationMatrix(suite, [benchmark("first"), benchmark("second")]);

    expect(
      cells.map((cell) => `${cell.benchmark.id}/${cell.arm.label}/${cell.repetition}`),
    ).toEqual([
      "first/independent/1",
      "first/independent/2",
      "first/none/1",
      "first/none/2",
      "second/independent/1",
      "second/independent/2",
      "second/none/1",
      "second/none/2",
    ]);
  });

  it("prints a dry-run matrix without adding persistence fields", () => {
    const suite = {
      label: "test",
      arms: [{ label: "none", jobPatch: { reviewMode: "none" as const } }],
      repetitions: 1,
      caseIds: ["first"],
    };

    expect(formatEvaluationMatrix(suite, [benchmark("first")])).toContain(
      "1\tfirst\tnone\t1\t900s\t$1.00",
    );
  });
});

describe("evaluation metrics", () => {
  it("reads quality totals from binding validation checks and the diff stat", () => {
    const metrics = buildMetrics(
      job(),
      validationReport,
      null,
      { filesChanged: 2, insertions: 7, deletions: 3 },
      { total: 4, passed: 3, failed: 1, skipped: 0, parsed: true },
    );

    expect(metrics).toMatchObject({
      runtimeSeconds: 6,
      totalCostUsd: "0.1234",
      attemptCount: 2,
      reviewDecision: "approve",
      reviewBlockingCount: 0,
      validationOutcome: "regressed",
      newFailureCount: 2,
      fixedFailureCount: 1,
      filesChanged: 2,
      insertions: 7,
      deletions: 3,
      hiddenTestsTotal: 4,
      hiddenTestsPassed: 3,
    });
  });

  it("keeps absent validation and diff evidence distinct from zero", () => {
    const metrics = buildMetrics(job({ reviewDecision: null }), null, null, null, null);

    expect(metrics).toMatchObject({
      validationOutcome: null,
      newFailureCount: null,
      fixedFailureCount: null,
      filesChanged: null,
      insertions: null,
      deletions: null,
      hiddenTestsTotal: null,
      hiddenTestsPassed: null,
      reviewBlockingCount: null,
    });
  });
});

describe("waitForTerminal", () => {
  it("polls until a terminal status and does not wait after it arrives", async () => {
    const statuses = ["queued", "implementing", "completed"] as const;
    let reads = 0;
    const result = await waitForTerminal("job", {
      timeoutMs: 10_000,
      pollIntervalMs: 1,
      readJob: () =>
        Promise.resolve(
          job({ status: statuses[Math.min(reads++, statuses.length - 1)] ?? "completed" }),
        ),
      sleep: () => Promise.resolve(),
    });

    expect(result.reason).toBe("terminal");
    expect(result.job?.status).toBe("completed");
    expect(reads).toBe(3);
  });

  it("returns a bounded timeout instead of hanging on a non-terminal job", async () => {
    const result = await waitForTerminal("job", {
      timeoutMs: 0,
      readJob: () => Promise.resolve(job({ status: "queued" })),
      sleep: () => Promise.resolve(),
    });

    expect(result.reason).toBe("timeout");
    expect(result.job?.status).toBe("queued");
  });
});
