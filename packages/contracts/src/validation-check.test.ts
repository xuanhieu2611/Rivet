import { describe, expect, it } from "vitest";

import {
  jobOutcomeFrom,
  parseBaselineReport,
  parseSerializedBaselineReport,
  parseSerializedValidationReport,
  parseValidationReport,
  serializeBaselineReport,
  serializeValidationReport,
  type CheckComparison,
  type CheckKind,
  type ValidationReport,
} from "./index";

const OUTCOMES = ["verified", "fixed", "regressed", "unresolved", "unverified"] as const;

function comparison(
  kind: CheckKind,
  outcome: (typeof OUTCOMES)[number],
): Pick<CheckComparison, "kind" | "outcome"> {
  return { kind, outcome };
}

describe("jobOutcomeFrom", () => {
  const contributions = {
    targeted_test: ["unverified", "unverified", "unverified", "unverified", "unverified"],
    test: ["verified", "fixed", "regressed", "unresolved", "unverified"],
    typecheck: ["verified", "fixed", "regressed", "unverified", "unverified"],
    lint: ["verified", "fixed", "regressed", "unverified", "unverified"],
  } as const;

  it.each(
    Object.entries(contributions).flatMap(([kind, expected]) =>
      OUTCOMES.map((outcome, index) => [kind, outcome, expected[index]] as const),
    ),
  )("aggregates %s=%s to %s", (kind, outcome, expected) => {
    expect(jobOutcomeFrom([comparison(kind as CheckKind, outcome)])).toBe(expected);
  });

  it("uses the documented priority across contributing checks", () => {
    expect(
      jobOutcomeFrom([
        comparison("test", "fixed"),
        comparison("typecheck", "unverified"),
        comparison("lint", "verified"),
      ]),
    ).toBe("unverified");
    expect(
      jobOutcomeFrom([comparison("test", "unresolved"), comparison("typecheck", "regressed")]),
    ).toBe("regressed");
  });

  it("does not make pre-existing lint or typecheck failures terminal", () => {
    expect(
      jobOutcomeFrom([
        comparison("test", "verified"),
        comparison("typecheck", "unresolved"),
        comparison("lint", "unresolved"),
      ]),
    ).toBe("unverified");
  });

  it("is unverified when no binding check contributed", () => {
    expect(jobOutcomeFrom([])).toBe("unverified");
    expect(jobOutcomeFrom([comparison("targeted_test", "regressed")])).toBe("unverified");
  });
});

describe("canonical validation reports", () => {
  const baseline = {
    checks: [
      {
        source: "package_json",
        status: "failed",
        kind: "test",
        tests: {
          parsed: true,
          failures: ["z.test.ts::z", "a.test.ts::a"],
          skipped: 0,
          failed: 2,
          passed: 3,
          total: 5,
          framework: "vitest",
        },
        exitCode: 1,
        argv: ["pnpm", "test"],
      },
      {
        reason: "the repository declares no lint command",
        source: "package_json",
        status: "skipped",
        kind: "lint",
      },
    ],
  } as const;

  const report: ValidationReport = {
    outcome: "unresolved",
    checks: [
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
          failures: ["b.test.ts::B"],
          parsed: true,
        },
        attribution: {
          newFailures: [],
          preExistingFailures: ["b.test.ts::B"],
          fixedFailures: ["z.test.ts::Z", "a.test.ts::A"],
        },
      },
    ],
    targetedPaths: ["src/z.test.ts", "src/a.test.ts"],
  };

  it("canonicalizes and round-trips a baseline report", () => {
    const serialized = serializeBaselineReport(baseline);

    expect(serialized).toBe(
      '{"checks":[{"kind":"test","status":"failed","source":"package_json","argv":["pnpm","test"],"exitCode":1,"tests":{"framework":"vitest","total":5,"passed":3,"failed":2,"skipped":0,"failures":["a.test.ts::a","z.test.ts::z"],"parsed":true}},{"kind":"lint","status":"skipped","source":"package_json","reason":"the repository declares no lint command"}]}',
    );
    expect(parseSerializedBaselineReport(serialized)).toEqual(parseBaselineReport(baseline));
  });

  it("canonicalizes and round-trips a validation report", () => {
    const serialized = serializeValidationReport(report);

    expect(serialized).toContain('"fixedFailures":["a.test.ts::A","z.test.ts::Z"]');
    expect(serialized).toContain('"targetedPaths":["src/a.test.ts","src/z.test.ts"]');
    expect(parseSerializedValidationReport(serialized)).toEqual(parseValidationReport(report));
  });

  it("rejects oversized failure name lists", () => {
    const failures = Array.from({ length: 201 }, (_, index) => `test.ts::failure ${index}`);
    expect(() =>
      parseBaselineReport({
        checks: [
          {
            kind: "test",
            status: "failed",
            source: "package_json",
            tests: {
              framework: "jest",
              total: 201,
              passed: 0,
              failed: 201,
              skipped: 0,
              failures,
              parsed: true,
            },
          },
        ],
      }),
    ).toThrow();
  });
});
