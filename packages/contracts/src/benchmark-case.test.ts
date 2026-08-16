import { describe, expect, it } from "vitest";

import {
  BENCHMARK_CATEGORIES,
  benchmarkCaseSchema,
  benchmarkCategorySchema,
  benchmarkDifficultySchema,
} from "./benchmark-case";

const VALID_CASE = {
  id: "bulk-discount-boundary",
  title: "Fix the bulk discount boundary",
  category: "bug_fix",
  difficulty: 1,
  issue: "The fixture says that 10 items or more qualify for the bulk discount.",
  setupCommand: null,
  validationCommand: ["node", "--test", "hidden/"],
  expectedBehavior: "qualifiesForBulkDiscount(10) is true and the public suite stays green.",
  reviewMode: "independent",
  maxCostUsd: "1.00",
  maxDurationSeconds: 900,
  commit: {
    author: "Rivet Benchmarks",
    email: "benchmarks@example.com",
    date: "2020-01-01T00:00:00.000Z",
  },
} as const;

describe("benchmarkCaseSchema", () => {
  it("accepts the complete case-file contract", () => {
    expect(benchmarkCaseSchema.parse(VALID_CASE)).toEqual(VALID_CASE);
  });

  it("accepts every PRD task category", () => {
    for (const category of BENCHMARK_CATEGORIES) {
      expect(benchmarkCategorySchema.parse(category)).toBe(category);
    }
  });

  it("accepts the complete difficulty ladder and rejects values outside it", () => {
    for (const difficulty of [1, 2, 3, 4, 5, 6]) {
      expect(benchmarkDifficultySchema.parse(difficulty)).toBe(difficulty);
    }

    for (const difficulty of [0, 7, 1.5, "3"]) {
      expect(benchmarkDifficultySchema.safeParse(difficulty).success).toBe(false);
    }
  });

  it("rejects unknown fields at every case boundary", () => {
    expect(benchmarkCaseSchema.safeParse({ ...VALID_CASE, unexpected: true }).success).toBe(false);
    expect(
      benchmarkCaseSchema.safeParse({
        ...VALID_CASE,
        commit: { ...VALID_CASE.commit, timezone: "UTC" },
      }).success,
    ).toBe(false);
    expect(benchmarkCaseSchema.safeParse({ ...VALID_CASE, category: "other" }).success).toBe(false);
  });

  it("requires non-empty argv arrays and rejects shell strings", () => {
    expect(benchmarkCaseSchema.safeParse({ ...VALID_CASE, validationCommand: [] }).success).toBe(
      false,
    );
    expect(benchmarkCaseSchema.safeParse({ ...VALID_CASE, validationCommand: [""] }).success).toBe(
      false,
    );
    expect(
      benchmarkCaseSchema.safeParse({ ...VALID_CASE, validationCommand: "node --test" }).success,
    ).toBe(false);
    expect(
      benchmarkCaseSchema.safeParse({ ...VALID_CASE, setupCommand: "pnpm build" }).success,
    ).toBe(false);
    expect(benchmarkCaseSchema.safeParse({ ...VALID_CASE, setupCommand: [] }).success).toBe(false);
  });

  it("allows a setup command to be explicitly absent", () => {
    expect(
      benchmarkCaseSchema.parse({ ...VALID_CASE, setupCommand: null }).setupCommand,
    ).toBeNull();
  });

  it("validates the pinned commit metadata and budgets", () => {
    expect(
      benchmarkCaseSchema.safeParse({
        ...VALID_CASE,
        commit: { ...VALID_CASE.commit, email: "not-an-email" },
      }).success,
    ).toBe(false);
    expect(
      benchmarkCaseSchema.safeParse({
        ...VALID_CASE,
        commit: { ...VALID_CASE.commit, date: "not-a-date" },
      }).success,
    ).toBe(false);
    expect(benchmarkCaseSchema.safeParse({ ...VALID_CASE, maxCostUsd: 1 }).success).toBe(false);
    expect(benchmarkCaseSchema.safeParse({ ...VALID_CASE, maxCostUsd: "-1.00" }).success).toBe(
      false,
    );
    expect(benchmarkCaseSchema.safeParse({ ...VALID_CASE, maxDurationSeconds: 0 }).success).toBe(
      false,
    );
  });
});
