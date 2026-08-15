import { serializeBaselineReport } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { baselineReportFrom } from "./baseline-report";

const report = serializeBaselineReport({
  checks: [{ kind: "test", status: "passed", source: "package_json" }],
});

describe("baselineReportFrom", () => {
  it("reads a complete canonical baseline report", () => {
    expect(baselineReportFrom([{ content: report, truncated: false }])).toEqual({
      checks: [{ kind: "test", status: "passed", source: "package_json" }],
    });
  });

  it.each([
    ["missing", []],
    ["truncated", [{ content: report, truncated: true }]],
    ["malformed", [{ content: "{", truncated: false }]],
    ["schema-invalid", [{ content: '{"checks":[] ,"extra":true}', truncated: false }]],
  ] as const)("returns null for a %s latest artifact", (_name, rows) => {
    expect(baselineReportFrom(rows)).toBeNull();
  });

  it("does not silently substitute an older report for a malformed latest attempt", () => {
    expect(
      baselineReportFrom([
        { content: "{", truncated: false },
        { content: report, truncated: false },
      ]),
    ).toBeNull();
  });
});
