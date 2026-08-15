import { describe, expect, it } from "vitest";

import {
  parseReviewReport,
  parseSerializedReviewReport,
  REVIEW_REPORT_LIMITS,
  reviewIssueSchema,
  reviewModeSchema,
  reviewReportSchema,
  serializeReviewReport,
} from "./review-report";

const ISSUE = {
  title: "  Empty orders total zero  ",
  detail: "  `orderTotalCents([])` returns 0 where the issue asks it to throw.  ",
  paths: ["  src/order.ts  "],
  category: "edge_case" as const,
};

const APPROVED = {
  decision: "approve" as const,
  blockingIssues: [],
  nonBlockingIssues: [ISSUE],
  confidence: 0.8,
  summary: "  The patch matches the plan and the tests are meaningful.  ",
};

const REVISE = {
  ...APPROVED,
  decision: "revise" as const,
  blockingIssues: [ISSUE],
  nonBlockingIssues: [],
};

describe("review issues", () => {
  it("trims every value and defaults paths to an empty list", () => {
    const parsed = reviewIssueSchema.parse({
      title: "  Discount rounded once  ",
      detail: "  The discount is applied to the order rather than per line.  ",
      category: "correctness",
    });

    expect(parsed).toEqual({
      title: "Discount rounded once",
      detail: "The discount is applied to the order rather than per line.",
      paths: [],
      category: "correctness",
    });
  });

  it("rejects empty text, an unknown category, an extra field, and overlong values", () => {
    expect(reviewIssueSchema.safeParse({ ...ISSUE, title: "   " }).success).toBe(false);
    expect(reviewIssueSchema.safeParse({ ...ISSUE, detail: "   " }).success).toBe(false);
    expect(reviewIssueSchema.safeParse({ ...ISSUE, category: "style" }).success).toBe(false);
    expect(reviewIssueSchema.safeParse({ ...ISSUE, unexpected: "field" }).success).toBe(false);
    expect(
      reviewIssueSchema.safeParse({
        ...ISSUE,
        title: "x".repeat(REVIEW_REPORT_LIMITS.titleMaxChars + 1),
      }).success,
    ).toBe(false);
    expect(
      reviewIssueSchema.safeParse({
        ...ISSUE,
        detail: "x".repeat(REVIEW_REPORT_LIMITS.detailMaxChars + 1),
      }).success,
    ).toBe(false);
  });

  it("bounds how many paths one finding may name", () => {
    const paths = (count: number) => Array.from({ length: count }, (_, index) => `src/${index}.ts`);

    expect(
      reviewIssueSchema.safeParse({
        ...ISSUE,
        paths: paths(REVIEW_REPORT_LIMITS.maxPathsPerIssue),
      }).success,
    ).toBe(true);
    expect(
      reviewIssueSchema.safeParse({
        ...ISSUE,
        paths: paths(REVIEW_REPORT_LIMITS.maxPathsPerIssue + 1),
      }).success,
    ).toBe(false);
    expect(reviewIssueSchema.safeParse({ ...ISSUE, paths: ["  "] }).success).toBe(false);
  });
});

describe("review reports", () => {
  it("accepts an approval with no blocking issues and trims what it keeps", () => {
    expect(parseReviewReport(APPROVED)).toEqual({
      decision: "approve",
      blockingIssues: [],
      nonBlockingIssues: [
        {
          title: "Empty orders total zero",
          detail: "`orderTotalCents([])` returns 0 where the issue asks it to throw.",
          paths: ["src/order.ts"],
          category: "edge_case",
        },
      ],
      confidence: 0.8,
      summary: "The patch matches the plan and the tests are meaningful.",
    });
  });

  it("rejects an approval that lists blocking issues", () => {
    const result = reviewReportSchema.safeParse({ ...APPROVED, blockingIssues: [ISSUE] });

    expect(result.success).toBe(false);
  });

  it("rejects a revision that names nothing to fix", () => {
    const result = reviewReportSchema.safeParse({ ...REVISE, blockingIssues: [] });

    expect(result.success).toBe(false);
  });

  it("accepts a revision with at least one blocking issue", () => {
    expect(reviewReportSchema.safeParse(REVISE).success).toBe(true);
  });

  it("bounds confidence to 0 through 1", () => {
    expect(reviewReportSchema.safeParse({ ...APPROVED, confidence: 0 }).success).toBe(true);
    expect(reviewReportSchema.safeParse({ ...APPROVED, confidence: 1 }).success).toBe(true);
    expect(reviewReportSchema.safeParse({ ...APPROVED, confidence: -0.1 }).success).toBe(false);
    expect(reviewReportSchema.safeParse({ ...APPROVED, confidence: 1.1 }).success).toBe(false);
    expect(reviewReportSchema.safeParse({ ...APPROVED, confidence: "high" }).success).toBe(false);
  });

  it("rejects an empty summary, an overlong summary, an unknown decision, and extra fields", () => {
    expect(reviewReportSchema.safeParse({ ...APPROVED, summary: "   " }).success).toBe(false);
    expect(
      reviewReportSchema.safeParse({
        ...APPROVED,
        summary: "x".repeat(REVIEW_REPORT_LIMITS.summaryMaxChars + 1),
      }).success,
    ).toBe(false);
    expect(reviewReportSchema.safeParse({ ...APPROVED, decision: "reject" }).success).toBe(false);
    expect(reviewReportSchema.safeParse({ ...APPROVED, unexpected: "field" }).success).toBe(false);
  });

  it("bounds how many findings each list may hold", () => {
    const issues = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...ISSUE, title: `Finding ${index}` }));

    expect(
      reviewReportSchema.safeParse({
        ...REVISE,
        blockingIssues: issues(REVIEW_REPORT_LIMITS.maxIssuesPerList),
      }).success,
    ).toBe(true);
    expect(
      reviewReportSchema.safeParse({
        ...REVISE,
        blockingIssues: issues(REVIEW_REPORT_LIMITS.maxIssuesPerList + 1),
      }).success,
    ).toBe(false);
    expect(
      reviewReportSchema.safeParse({
        ...APPROVED,
        nonBlockingIssues: issues(REVIEW_REPORT_LIMITS.maxIssuesPerList + 1),
      }).success,
    ).toBe(false);
  });

  it("serializes with stable key order and restores from JSON", () => {
    const serialized = serializeReviewReport(REVISE);

    expect(serialized).toBe(
      '{"decision":"revise",' +
        '"blockingIssues":[{"title":"Empty orders total zero",' +
        '"detail":"`orderTotalCents([])` returns 0 where the issue asks it to throw.",' +
        '"paths":["src/order.ts"],"category":"edge_case"}],' +
        '"nonBlockingIssues":[],' +
        '"confidence":0.8,' +
        '"summary":"The patch matches the plan and the tests are meaningful."}',
    );
    expect(parseSerializedReviewReport(serialized)).toEqual(parseReviewReport(REVISE));
    expect(serializeReviewReport(parseSerializedReviewReport(serialized))).toBe(serialized);
  });

  it("refuses anything that is not a JSON string, and invalid JSON", () => {
    expect(() => parseSerializedReviewReport(REVISE)).toThrow(/expected a string/);
    expect(() => parseSerializedReviewReport("{")).toThrow(/Invalid review report JSON/);
  });
});

describe("review modes", () => {
  it("accepts exactly independent and none", () => {
    expect(reviewModeSchema.parse("independent")).toBe("independent");
    expect(reviewModeSchema.parse("none")).toBe("none");
    expect(reviewModeSchema.safeParse("off").success).toBe(false);
  });
});
