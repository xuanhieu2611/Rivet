import {
  serializeValidationReport,
  type JobArtifact,
  type ValidationOutcome,
  type ValidationReport,
} from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { CHECK_KIND_LABELS, VALIDATION_OUTCOME_PRESENTATION } from "@/lib/validation-presentation";
import { readValidationReport } from "@/lib/validation-report";

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

describe("validation report presentation", () => {
  it("parses a complete validation report artifact", () => {
    expect(readValidationReport(artifact())).toEqual(REPORT);
  });

  it.each([
    ["missing", null],
    ["wrong artifact type", artifact({ type: "baseline_report" })],
    ["truncated", artifact({ truncated: true })],
    ["malformed JSON", artifact({ content: "{" })],
    ["old schema", artifact({ content: '{"validation":"verified"}' })],
    ["schema-invalid", artifact({ content: '{"outcome":"verified","checks":[{}]}' })],
  ] as const)("does not render a %s report", (_name, value) => {
    expect(readValidationReport(value)).toBeNull();
  });

  it("maps every validation outcome and check kind exhaustively", () => {
    const outcomes: ValidationOutcome[] = [
      "verified",
      "fixed",
      "regressed",
      "unresolved",
      "unverified",
    ];

    expect(outcomes.map((outcome) => VALIDATION_OUTCOME_PRESENTATION[outcome].label)).toEqual([
      "Verified",
      "Fixed",
      "Regressed",
      "Unresolved",
      "Unverified",
    ]);
    expect(Object.values(CHECK_KIND_LABELS)).toEqual([
      "Targeted tests",
      "Full test suite",
      "Typecheck",
      "Lint",
    ]);
  });
});
