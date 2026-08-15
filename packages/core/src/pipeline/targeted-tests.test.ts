import { describe, expect, it } from "vitest";

import { selectTargetedTests } from "./targeted-tests";

describe("selectTargetedTests", () => {
  it("selects a changed tracked test directly", () => {
    expect(
      selectTargetedTests({
        changedPaths: ["src/math.spec.ts"],
        trackedFiles: ["src/math.spec.ts"],
        maxFiles: 25,
      }),
    ).toEqual({ paths: ["src/math.spec.ts"] });
  });

  it.each([
    ["beside the source", "src/math.test.ts"],
    ["in a sibling __tests__ directory", "src/__tests__/math.test.tsx"],
    ["under the package test directory", "test/math.spec.js"],
    ["under the package tests directory", "tests/math.test.mts"],
  ])("selects a conventional counterpart %s", (_description, counterpart) => {
    expect(
      selectTargetedTests({
        changedPaths: ["src/math.ts"],
        trackedFiles: [counterpart],
        maxFiles: 25,
      }),
    ).toEqual({ paths: [counterpart] });
  });

  it("anchors test directories at the nearest package root", () => {
    expect(
      selectTargetedTests({
        changedPaths: ["packages/core/src/nested/math.ts"],
        trackedFiles: [
          "packages/core/test/nested/math.test.ts",
          "packages/core/tests/nested/math.spec.ts",
          "test/packages/core/src/nested/math.test.ts",
        ],
        maxFiles: 25,
      }),
    ).toEqual({
      paths: ["packages/core/test/nested/math.test.ts", "packages/core/tests/nested/math.spec.ts"],
    });
  });

  it("uses only JS and TS extensions present in tracked files", () => {
    expect(
      selectTargetedTests({
        changedPaths: ["src/math.ts"],
        trackedFiles: [
          "src/math.test.cts",
          "src/math.spec.jsx",
          "src/math.test.py",
          "src/unrelated.test.tsx",
        ],
        maxFiles: 25,
      }),
    ).toEqual({ paths: ["src/math.spec.jsx", "src/math.test.cts"] });
  });

  it("sorts and deduplicates direct and inferred selections", () => {
    expect(
      selectTargetedTests({
        changedPaths: ["src/z.ts", "src/a.test.ts", "src/a.ts", "src/a.test.ts"],
        trackedFiles: ["src/z.test.ts", "src/a.test.ts"],
        maxFiles: 25,
      }),
    ).toEqual({ paths: ["src/a.test.ts", "src/z.test.ts"] });
  });

  it("skips a selection above the cap", () => {
    expect(
      selectTargetedTests({
        changedPaths: ["src/a.ts", "src/b.ts"],
        trackedFiles: ["src/a.test.ts", "src/b.test.ts"],
        maxFiles: 1,
      }),
    ).toEqual({ skipped: true, reason: "2 targeted test files exceed the limit of 1" });
  });

  it("skips an empty diff with a specific reason", () => {
    expect(
      selectTargetedTests({ changedPaths: [], trackedFiles: ["src/a.test.ts"], maxFiles: 25 }),
    ).toEqual({ skipped: true, reason: "the diff contains no changed paths" });
  });

  it("skips a diff containing only non-source files", () => {
    expect(
      selectTargetedTests({
        changedPaths: ["README.md", "package.json", "docs/guide.yml"],
        trackedFiles: ["src/a.test.ts"],
        maxFiles: 25,
      }),
    ).toEqual({ skipped: true, reason: "the diff contains only non-source files" });
  });

  it("distinguishes source files with no counterpart", () => {
    expect(
      selectTargetedTests({
        changedPaths: ["src/a.ts"],
        trackedFiles: ["src/unrelated.test.ts"],
        maxFiles: 25,
      }),
    ).toEqual({
      skipped: true,
      reason: "no conventional tracked test files match the changed paths",
    });
  });
});
