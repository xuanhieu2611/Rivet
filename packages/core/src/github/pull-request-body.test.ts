import type { ImplementationPlan, ReviewReport, ValidationReport } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { composePullRequestBody } from "./pull-request-body";

const PLAN: ImplementationPlan = {
  problemInterpretation: "The availability check races with the booking insert.",
  relevantComponents: ["booking service"],
  reproductionStrategy: ["Run two requests concurrently."],
  implementationApproach: ["Make the write atomic."],
  validationPlan: ["Run the booking tests."],
  riskAreas: ["Existing duplicate rows need review."],
};

const REPORT: ValidationReport = {
  outcome: "verified",
  checks: [
    {
      kind: "test",
      status: "passed",
      source: "package_json",
      baseline: "passed",
      outcome: "verified",
      tests: {
        framework: "vitest",
        total: 12,
        passed: 12,
        failed: 0,
        skipped: 0,
        failures: [],
        parsed: true,
      },
    },
    {
      kind: "typecheck",
      status: "passed",
      source: "package_json",
      baseline: "passed",
      outcome: "verified",
    },
  ],
};

const REVIEW: ReviewReport = {
  decision: "approve",
  blockingIssues: [],
  nonBlockingIssues: [
    {
      title: "More instrumentation could help",
      detail: "Consider a metric for rejected concurrent requests.",
      paths: [],
      category: "weak_test",
    },
  ],
  confidence: 0.95,
  summary: "The patch is safe.",
};

describe("composePullRequestBody", () => {
  it("includes every section required by the PRD", () => {
    const body = composePullRequestBody({
      job: {
        id: "11111111-2222-3333-4444-555555555555",
        title: "Fix booking race",
        description: "Users can double-book a room.",
        issueUrl: "https://github.com/acme/widgets/issues/17",
      },
      plan: PLAN,
      implementationSummary: "The check and insert now share one transaction.",
      diffStat: {
        filesChanged: 2,
        insertions: 14,
        deletions: 3,
        paths: ["src/booking.ts", "test/booking.test.ts"],
      },
      validationReport: REPORT,
      reviewReport: REVIEW,
      runUrl: "http://localhost:3000/jobs/11111111-2222-3333-4444-555555555555",
    });

    expect(body).toContain("The availability check races with the booking insert.");
    expect(body).toContain("The check and insert now share one transaction.");
    expect(body).toContain("`src/booking.ts`");
    expect(body).toContain("+14/-3");
    expect(body).toContain("**test**: verified");
    expect(body).toContain("Existing duplicate rows need review.");
    expect(body).toContain("More instrumentation could help");
    expect(body).toContain("11111111-2222-3333-4444-555555555555");
    expect(body).toContain("http://localhost:3000/jobs/11111111-2222-3333-4444-555555555555");
  });

  it("keeps missing optional artifacts honest", () => {
    const body = composePullRequestBody({
      job: {
        id: "11111111-2222-3333-4444-555555555555",
        title: "Document the API",
        description: "Add the missing API documentation.",
        issueUrl: null,
      },
      plan: null,
      implementationSummary: null,
      diffStat: null,
      validationReport: null,
      reviewReport: null,
      runUrl: "/jobs/11111111-2222-3333-4444-555555555555",
    });

    expect(body).toContain("No root cause was recorded");
    expect(body).toContain("No implementation summary was recorded");
    expect(body).toContain("No diff statistics were recorded");
    expect(body).toContain("No structured validation report was recorded");
    expect(body).toContain("None recorded.");
  });
});
