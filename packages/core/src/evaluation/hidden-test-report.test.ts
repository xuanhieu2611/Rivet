import { describe, expect, it } from "vitest";

import { hiddenTestScore, hiddenTestsPassed, parseHiddenTestReport } from "./hidden-test-report";

/** What `node --test` writes when its output is not a terminal. */
function tap(counts: { tests: number; pass: number; fail: number; skipped?: number }): string {
  return [
    "TAP version 13",
    "ok 1 - charges the bulk rate at ten items",
    "not ok 2 - rejects a fractional quantity",
    "1..2",
    `# tests ${counts.tests}`,
    "# suites 0",
    `# pass ${counts.pass}`,
    `# fail ${counts.fail}`,
    "# cancelled 0",
    `# skipped ${counts.skipped ?? 0}`,
    "# todo 0",
    "# duration_ms 41.2",
    "",
  ].join("\n");
}

describe("parseHiddenTestReport", () => {
  it("reads the TAP summary", () => {
    const totals = parseHiddenTestReport({
      exitCode: 1,
      stdout: tap({ tests: 8, pass: 7, fail: 1 }),
    });

    expect(totals).toEqual({ total: 8, passed: 7, failed: 1, skipped: 0, parsed: true });
    expect(hiddenTestScore(totals)).toBe(0.875);
  });

  it("accepts the spec reporter's marker", () => {
    const totals = parseHiddenTestReport({
      exitCode: 0,
      stdout: ["ℹ tests 4", "ℹ pass 4", "ℹ fail 0", "ℹ skipped 0"].join("\n"),
    });

    expect(totals).toEqual({ total: 4, passed: 4, failed: 0, skipped: 0, parsed: true });
  });

  it("ignores a summary a test printed itself", () => {
    // A hidden test printing a diagnostic is completely ordinary, and reading
    // it as the suite's totals would be a silently wrong score.
    const totals = parseHiddenTestReport({
      exitCode: 0,
      stdout: ["the report said: # pass 99", "# tests 2", "# pass 2", "# fail 0"].join("\n"),
    });

    expect(totals).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0, parsed: true });
  });

  it("derives totals from the exit code when there is no summary", () => {
    expect(parseHiddenTestReport({ exitCode: 0, stdout: "all good\n" })).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      parsed: false,
    });
    expect(parseHiddenTestReport({ exitCode: 2, stdout: "boom\n" })).toEqual({
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      parsed: false,
    });
  });

  it("refuses to parse a truncated transcript", () => {
    // The summary is at the end, so a clipped stdout can drop the totals and
    // keep the `ok` lines - which would report a smaller suite and a better
    // score than the run earned.
    const totals = parseHiddenTestReport({
      exitCode: 0,
      stdout: tap({ tests: 8, pass: 8, fail: 0 }),
      truncated: true,
    });

    expect(totals.parsed).toBe(false);
    expect(totals.total).toBe(1);
  });

  it("falls back on a nonsensical summary", () => {
    expect(
      parseHiddenTestReport({ exitCode: 0, stdout: "# tests 2\n# pass 5\n# fail 0\n" }).parsed,
    ).toBe(false);
    expect(
      parseHiddenTestReport({ exitCode: 0, stdout: "# tests 0\n# pass 0\n# fail 0\n" }),
    ).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0, parsed: false });
  });
});

describe("hiddenTestsPassed", () => {
  it("requires both a zero exit and no reported failure", () => {
    const green = parseHiddenTestReport({
      exitCode: 0,
      stdout: tap({ tests: 3, pass: 3, fail: 0 }),
    });
    expect(hiddenTestsPassed({ exitCode: 0, stdout: "" }, green)).toBe(true);

    // A runner that exits zero having reported a failure is a runner nobody
    // should trust, and a benchmark is where that has to be noticed.
    const lying = parseHiddenTestReport({
      exitCode: 1,
      stdout: tap({ tests: 3, pass: 2, fail: 1 }),
    });
    expect(hiddenTestsPassed({ exitCode: 0, stdout: "" }, lying)).toBe(false);
    expect(hiddenTestsPassed({ exitCode: 1, stdout: "" }, green)).toBe(false);
  });
});

describe("hiddenTestScore", () => {
  it("rounds to the stored numeric(5,4) scale", () => {
    expect(hiddenTestScore({ total: 3, passed: 1, failed: 2, skipped: 0, parsed: true })).toBe(
      0.3333,
    );
    expect(hiddenTestScore({ total: 8, passed: 8, failed: 0, skipped: 0, parsed: true })).toBe(1);
    expect(hiddenTestScore({ total: 0, passed: 0, failed: 0, skipped: 0, parsed: false })).toBe(0);
  });
});
