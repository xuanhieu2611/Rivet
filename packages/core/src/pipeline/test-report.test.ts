import { readFileSync } from "node:fs";

import { VALIDATION_REPORT_LIMITS, type TestReport } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  attribute,
  detectTestFramework,
  parseJestJson,
  parseVitestJson,
  reporterArgs,
} from "./test-report";

const vitestFixture = readFileSync(
  new URL("./fixtures/vitest-report.json", import.meta.url),
  "utf8",
);
const jestFixture = readFileSync(new URL("./fixtures/jest-report.json", import.meta.url), "utf8");

describe("detectTestFramework", () => {
  it("checks devDependencies before dependencies and script text", () => {
    expect(
      detectTestFramework(
        { devDependencies: { vitest: "4" }, dependencies: { jest: "30" } },
        "jest --runInBand",
      ),
    ).toBe("vitest");
  });

  it("checks dependencies after devDependencies", () => {
    expect(detectTestFramework({ dependencies: { jest: "30" } }, "node test.js")).toBe("jest");
  });

  it.each([
    ["vitest run", "vitest"],
    ["node ./node_modules/.bin/jest --runInBand", "jest"],
    ["cross-env NODE_ENV=test vitest", "vitest"],
  ] as const)("detects the runner in script %s", (script, expected) => {
    expect(detectTestFramework({}, script)).toBe(expected);
  });

  it.each([
    [null, "node test.js"],
    [{ devDependencies: "vitest" }, "node test.js"],
    [{ dependencies: { "vitest-browser-react": "1" } }, "node test.js"],
    [{}, "run-vitest-wrapper"],
  ])("returns null for unsupported input %#", (manifest, script) => {
    expect(detectTestFramework(manifest, script)).toBeNull();
  });
});

describe("reporterArgs", () => {
  it.each([
    ["vitest", "--reporter=json"],
    ["jest", "--json"],
  ] as const)("builds the %s JSON reporter suffix", (framework, reporterArg) => {
    expect(reporterArgs({ framework }, "/work/validation/report.json")).toEqual([
      reporterArg,
      "--outputFile",
      "/work/validation/report.json",
    ]);
  });

  it("preserves a custom non-dash output argument exactly", () => {
    expect(
      reporterArgs({ framework: "vitest", outputArg: "report-file" }, "/tmp/result.json"),
    ).toEqual(["--reporter=json", "report-file", "/tmp/result.json"]);
  });

  it.each(["", "bad\0path"])("degrades for an unusable output path", (outputPath) => {
    expect(reporterArgs({ framework: "jest" }, outputPath)).toBeNull();
  });
});

describe("test report parsing", () => {
  it("parses captured Vitest JSON and makes its absolute path repository-relative", () => {
    expect(parseVitestJson(vitestFixture)).toEqual({
      framework: "vitest",
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      failures: ["packages/core/src/pipeline/stage3-capture.test.ts::calculator adds two values"],
      parsed: true,
    });
  });

  it("parses captured Jest JSON", () => {
    expect(parseJestJson(jestFixture)).toEqual({
      framework: "jest",
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      failures: ["packages/core/.stage3-capture/jest.test.js::account credits a deposit"],
      parsed: true,
    });
  });

  it("produces the same identity across replacement-container paths", () => {
    const first = vitestFixture.replace(
      "/Users/hieule/hieu/code/Rivet/packages/core/src/pipeline/stage3-capture.test.ts",
      "/var/rivet/attempt-one/repo/src/calculator.test.ts",
    );
    const second = first.replace(
      "/var/rivet/attempt-one/repo/src/calculator.test.ts",
      "/different/workdir/repo/src/calculator.test.ts",
    );

    expect(parseVitestJson(first).failures).toEqual([
      "src/calculator.test.ts::calculator adds two values",
    ]);
    expect(parseVitestJson(second).failures).toEqual(parseVitestJson(first).failures);
  });

  it.each([
    ["empty", ""],
    ["truncated", '{"numTotalTests": 3'],
    ["valid JSON that is not a report", '{"success":false}'],
    [
      "wrong nested shape",
      '{"numTotalTests":0,"numPassedTests":0,"numFailedTests":0,"numPendingTests":0,"testResults":{}}',
    ],
  ])("degrades for %s input", (_name, text) => {
    expect(parseVitestJson(text)).toEqual({
      framework: "vitest",
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      failures: [],
      parsed: false,
    });
  });

  it("keeps exact counts while sorting, deduplicating, and bounding failure names", () => {
    const assertions = Array.from({ length: 250 }, (_, index) => ({
      status: "failed",
      fullName: `failure ${String(249 - index).padStart(3, "0")}`,
    }));
    assertions.push(assertions[0]!);
    const report = JSON.stringify({
      numTotalTests: 250,
      numPassedTests: 0,
      numFailedTests: 250,
      numPendingTests: 0,
      testResults: [{ name: "/work/repo/test/example.test.ts", assertionResults: assertions }],
    });

    const parsed = parseJestJson(report);
    expect(parsed.failed).toBe(250);
    expect(parsed.failures).toHaveLength(VALIDATION_REPORT_LIMITS.maxFailureNames);
    expect(parsed.failures[0]).toBe("test/example.test.ts::failure 000");
    expect(parsed.failures.at(-1)).toBe("test/example.test.ts::failure 199");
  });
});

describe("attribute", () => {
  const report = (failures: string[]): Pick<TestReport, "failures"> => ({ failures });

  it("computes sorted new, pre-existing, and fixed failure sets", () => {
    expect(attribute(report(["b", "a", "fixed"]), report(["new", "b", "a"]))).toEqual({
      newFailures: ["new"],
      preExistingFailures: ["a", "b"],
      fixedFailures: ["fixed"],
    });
  });

  it("treats a renamed test as one new and one fixed failure", () => {
    expect(
      attribute(report(["file.test.ts::old name"]), report(["file.test.ts::new name"])),
    ).toEqual({
      newFailures: ["file.test.ts::new name"],
      preExistingFailures: [],
      fixedFailures: ["file.test.ts::old name"],
    });
  });

  it("deduplicates and bounds every output set", () => {
    const before = Array.from({ length: 250 }, (_, index) => `shared-${index}`);
    const after = [
      ...before,
      ...before,
      ...Array.from({ length: 250 }, (_, index) => `new-${index}`),
    ];
    const result = attribute(report(before), report(after));

    expect(result.preExistingFailures).toHaveLength(VALIDATION_REPORT_LIMITS.maxFailureNames);
    expect(result.newFailures).toHaveLength(VALIDATION_REPORT_LIMITS.maxFailureNames);
    expect(result.fixedFailures).toEqual([]);
    expect(result.newFailures).toEqual([...result.newFailures].sort());
  });
});
