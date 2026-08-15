import { serializeReviewReport, type JobArtifact, type ReviewIssue } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  formatReviewConfidence,
  groupReviewIssues,
  readReviewReport,
  REVIEW_ISSUE_CATEGORY_LABELS,
} from "@/lib/review-report";

const REPORT = {
  decision: "revise" as const,
  blockingIssues: [
    {
      title: "The lock is acquired too late",
      detail: "Two requests can still pass the check before either writes the reservation.",
      paths: ["src/booking.ts"],
      category: "concurrency" as const,
    },
  ],
  nonBlockingIssues: [
    {
      title: "Add an empty-input case",
      detail: "The new helper has no test documenting its behavior for an empty list.",
      paths: ["test/booking.test.ts"],
      category: "weak_test" as const,
    },
  ],
  confidence: 0.875,
  summary: "The race remains possible, so the patch needs another pass.",
};

function artifact(overrides: Partial<JobArtifact> = {}): JobArtifact {
  return {
    id: 42,
    jobId: "11111111-1111-4111-8111-111111111111",
    type: "review_report",
    phase: "reviewing",
    content: serializeReviewReport(REPORT),
    byteSize: 512,
    truncated: false,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("review report presentation", () => {
  it("parses a complete review report artifact", () => {
    expect(readReviewReport(artifact())).toEqual(REPORT);
  });

  it.each([
    ["missing", null],
    ["wrong artifact type", artifact({ type: "validation_report" })],
    ["truncated", artifact({ truncated: true })],
    ["malformed JSON", artifact({ content: "{" })],
    ["schema-invalid", artifact({ content: '{"decision":"approve"}' })],
  ] as const)("does not render a %s report", (_name, value) => {
    expect(readReviewReport(value)).toBeNull();
  });

  it("groups each finding list in stable category order", () => {
    const issues: ReviewIssue[] = [
      ...REPORT.nonBlockingIssues,
      ...REPORT.blockingIssues,
      {
        title: "The error is hard to diagnose",
        detail: "Preserve the original conflict detail.",
        paths: [],
        category: "correctness",
      },
      {
        title: "The test covers the happy path only",
        detail: "Add the conflict branch to the regression test.",
        paths: [],
        category: "weak_test",
      },
    ];

    const groups = groupReviewIssues(issues);

    expect(groups.map((group) => group.category)).toEqual([
      "correctness",
      "concurrency",
      "weak_test",
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      REVIEW_ISSUE_CATEGORY_LABELS.correctness,
      REVIEW_ISSUE_CATEGORY_LABELS.concurrency,
      REVIEW_ISSUE_CATEGORY_LABELS.weak_test,
    ]);
    expect(groups[2]?.issues).toHaveLength(2);
  });

  it("formats confidence as a whole percentage", () => {
    expect(formatReviewConfidence(0)).toBe("0%");
    expect(formatReviewConfidence(0.875)).toBe("88%");
    expect(formatReviewConfidence(1)).toBe("100%");
  });
});
