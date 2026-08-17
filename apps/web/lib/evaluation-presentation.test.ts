import { RUN_RESULTS } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  formatCategory,
  formatFailureLabel,
  formatRuntimeSeconds,
  formatScore,
  formatScoreSpread,
  formatSuccessFraction,
  formatSuccessRate,
  RUN_RESULT_PRESENTATION,
  suiteStatusClassName,
  UNLABELED_FAILURE_LABEL,
} from "./evaluation-presentation";

describe("RUN_RESULT_PRESENTATION", () => {
  it("covers every run result", () => {
    expect(Object.keys(RUN_RESULT_PRESENTATION).slice().sort()).toEqual(
      [...RUN_RESULTS].slice().sort(),
    );
  });

  it("marks only passed and failed as graded", () => {
    const graded = RUN_RESULTS.filter((result) => RUN_RESULT_PRESENTATION[result].graded);
    expect(graded).toEqual(["passed", "failed"]);
  });
});

describe("formatSuccessRate", () => {
  it("distinguishes an ungradable group from a zero rate", () => {
    expect(formatSuccessRate(null)).toBe("n/a");
    expect(formatSuccessRate(0)).toBe("0%");
  });

  it("keeps a fractional rate readable", () => {
    expect(formatSuccessRate(1)).toBe("100%");
    expect(formatSuccessRate(2 / 3)).toBe("66.7%");
  });
});

describe("formatSuccessFraction", () => {
  it("names the runs excluded from the denominator", () => {
    expect(formatSuccessFraction({ passed: 1, graded: 2, total: 2 })).toBe("1/2");
    expect(formatSuccessFraction({ passed: 1, graded: 2, total: 4 })).toBe("1/2 (+2 not graded)");
  });
});

describe("formatScore and formatScoreSpread", () => {
  it("keeps a near miss visible", () => {
    expect(formatScore(0.25)).toBe("0.25");
    expect(formatScore(null)).toBe("-");
  });

  it("collapses a spread with no spread", () => {
    expect(formatScoreSpread(1, 1)).toBe("1.00");
    expect(formatScoreSpread(0.25, 1)).toBe("0.25-1.00");
    expect(formatScoreSpread(null, null)).toBe("-");
  });
});

describe("formatFailureLabel", () => {
  it("names the unlabelled bucket rather than blanking it", () => {
    expect(formatFailureLabel(null)).toBe(UNLABELED_FAILURE_LABEL);
  });

  it("reads the machine diagnosis as a sentence", () => {
    expect(formatFailureLabel("grade_workspace_invalid")).toBe("Grading workspace invalid");
    expect(formatFailureLabel("Budget exceeded")).toBe("Budget exceeded");
  });
});

describe("formatRuntimeSeconds", () => {
  it("formats sub-minute and multi-minute runtimes", () => {
    expect(formatRuntimeSeconds(null)).toBe("n/a");
    expect(formatRuntimeSeconds(42.25)).toBe("42.3s");
    expect(formatRuntimeSeconds(120)).toBe("2m");
    expect(formatRuntimeSeconds(125)).toBe("2m 5s");
  });
});

describe("suiteStatusClassName and formatCategory", () => {
  it("falls back to a neutral tone for an unknown status", () => {
    expect(suiteStatusClassName("running")).toContain("sky");
    expect(suiteStatusClassName("nonsense")).toContain("muted");
  });

  it("humanizes a snake_case category", () => {
    expect(formatCategory("bug_fix")).toBe("Bug fix");
    expect(formatCategory("api_change")).toBe("Api change");
  });
});
