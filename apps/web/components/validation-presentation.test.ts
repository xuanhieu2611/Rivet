import {
  serializeValidationReport,
  type JobArtifact,
  type JobEvent,
  type ValidationReport,
} from "@rivet/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExecutionTimeline } from "@/components/execution-timeline";
import { ValidationPanel } from "@/components/validation-panel";

const REPORT: ValidationReport = {
  outcome: "unresolved",
  checks: [
    {
      kind: "targeted_test",
      status: "passed",
      source: "package_json",
      baseline: null,
      outcome: "unverified",
    },
    {
      kind: "test",
      status: "failed",
      source: "package_json",
      argv: ["pnpm", "test"],
      exitCode: 1,
      baseline: "failed",
      outcome: "unresolved",
      tests: {
        framework: "vitest",
        total: 4,
        passed: 3,
        failed: 1,
        skipped: 0,
        failures: ["src/cart.test.ts::keeps tax"],
        parsed: true,
      },
      attribution: {
        newFailures: ["src/new.test.ts::new regression"],
        preExistingFailures: ["src/cart.test.ts::keeps tax"],
        fixedFailures: ["src/old.test.ts::old failure"],
      },
    },
    {
      kind: "typecheck",
      status: "passed",
      source: "package_json",
      baseline: "failed",
      outcome: "fixed",
    },
    {
      kind: "lint",
      status: "passed",
      source: "package_json",
      baseline: "passed",
      outcome: "verified",
    },
  ],
  targetedPaths: ["src/cart.test.ts"],
};

function artifact(overrides: Partial<JobArtifact> = {}): JobArtifact {
  return {
    id: 42,
    jobId: "11111111-1111-4111-8111-111111111111",
    type: "validation_report",
    phase: "testing",
    content: serializeValidationReport(REPORT),
    byteSize: 512,
    truncated: false,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function event(overrides: Partial<JobEvent>): JobEvent {
  return {
    id: 1,
    jobId: "11111111-1111-4111-8111-111111111111",
    type: "baseline.check_recorded",
    message: "recorded",
    data: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("validation timeline presentations", () => {
  it("names a baseline check and its pre-implementation result", () => {
    const html = renderToStaticMarkup(
      createElement(ExecutionTimeline, {
        events: [
          event({
            type: "baseline.check_recorded",
            data: { check: "typecheck", checkStatus: "failed" },
          }),
        ],
      }),
    );

    expect(html).toContain("Typecheck");
    expect(html).toContain("Failed");
    expect(html).toContain('data-event-type="baseline.check_recorded"');
    expect(html).not.toContain("recorded</p>");
  });

  it("names a compared check and its validation outcome", () => {
    const html = renderToStaticMarkup(
      createElement(ExecutionTimeline, {
        events: [
          event({
            type: "validation.check_recorded",
            data: { check: "test", checkStatus: "failed", checkOutcome: "unresolved" },
          }),
        ],
      }),
    );

    expect(html).toContain("Full test suite");
    expect(html).toContain("Unresolved");
    expect(html).toContain('data-event-type="validation.check_recorded"');
    expect(html).toContain("bg-red-500");
  });
});

describe("ValidationPanel", () => {
  it("renders an outcome-badged row, attribution lists, and targeted path count", () => {
    const html = renderToStaticMarkup(createElement(ValidationPanel, { artifact: artifact() }));

    expect(html).toContain("Overall validation outcome");
    for (const kind of ["targeted_test", "test", "typecheck", "lint"]) {
      expect(html).toContain(`data-check-kind="${kind}"`);
    }
    expect(html).toContain('data-validation-outcome="unresolved"');
    expect(html).toContain('data-validation-outcome="unverified"');
    expect(html).toContain('data-validation-outcome="fixed"');
    expect(html).toContain('data-validation-outcome="verified"');
    expect(html).toContain("Baseline failed · after failed · 4 tests");
    expect(html).toContain("Failure attribution (3 results)");
    expect(html).toContain("New failures (1)");
    expect(html).toContain("src/new.test.ts::new regression");
    expect(html).toContain("Pre-existing failures (1)");
    expect(html).toContain("src/cart.test.ts::keeps tax");
    expect(html).toContain("Fixed failures (1)");
    expect(html).toContain("src/old.test.ts::old failure");
    expect(html).toContain("Targeted selection (1 path)");
    expect(html).toContain("src/cart.test.ts");
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html.match(/<summary/g)).toHaveLength(2);
  });

  it("explains a missing report for a pre-M7 job", () => {
    const html = renderToStaticMarkup(createElement(ValidationPanel, { artifact: null }));

    expect(html).toContain("No validation report has been recorded");
    expect(html).toContain("Older jobs");
  });

  it.each([
    ["truncated", artifact({ truncated: true })],
    ["malformed", artifact({ content: "{" })],
    ["old", artifact({ content: '{"validation":"verified"}' })],
  ] as const)("keeps a %s report diagnosable without rendering it", (_name, value) => {
    const html = renderToStaticMarkup(createElement(ValidationPanel, { artifact: value }));

    expect(html).toContain(`Artifact #${String(value.id)} is not a readable structured`);
    expect(html).toContain("listed under Artifacts");
    expect(html).not.toContain('data-check-kind="test"');
  });
});
