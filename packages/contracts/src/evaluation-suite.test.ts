import { describe, expect, it } from "vitest";

import {
  evaluationArmSchema,
  evaluationJobPatchSchema,
  evaluationSuiteSchema,
} from "./evaluation-suite";

const VALID_SUITE = {
  label: "Reviewer value experiment",
  arms: [
    { label: "independent", jobPatch: { reviewMode: "independent" } },
    { label: "none", jobPatch: { reviewMode: "none" } },
  ],
  repetitions: 2,
  caseIds: ["bulk-discount-boundary", "multi-line-order"],
} as const;

describe("evaluationJobPatchSchema", () => {
  it("accepts supported job configuration overrides", () => {
    expect(
      evaluationJobPatchSchema.parse({
        reviewMode: "independent",
        maxReviewLoops: 2,
        maxDurationSeconds: 900,
        maxCostUsd: "1.00",
        maxModelCalls: 40,
        maxToolCalls: 80,
      }),
    ).toEqual({
      reviewMode: "independent",
      maxReviewLoops: 2,
      maxDurationSeconds: 900,
      maxCostUsd: "1.00",
      maxModelCalls: 40,
      maxToolCalls: 80,
    });
  });

  it("rejects unknown patch fields and invalid budget values", () => {
    expect(evaluationJobPatchSchema.safeParse({ model: "other-model" }).success).toBe(false);
    expect(evaluationJobPatchSchema.safeParse({ maxReviewLoops: 6 }).success).toBe(false);
    expect(evaluationJobPatchSchema.safeParse({ maxCostUsd: "free" }).success).toBe(false);
    expect(evaluationJobPatchSchema.safeParse({ maxToolCalls: 0 }).success).toBe(false);
  });
});

describe("evaluationArmSchema", () => {
  it("requires a label and a structured patch", () => {
    expect(evaluationArmSchema.parse(VALID_SUITE.arms[0])).toEqual(VALID_SUITE.arms[0]);
    expect(
      evaluationArmSchema.safeParse({ label: "independent", jobPatch: {}, extra: true }).success,
    ).toBe(false);
    expect(evaluationArmSchema.safeParse({ label: "independent" }).success).toBe(false);
  });
});

describe("evaluationSuiteSchema", () => {
  it("accepts a runner suite and defaults repetitions to three", () => {
    expect(evaluationSuiteSchema.parse(VALID_SUITE)).toEqual(VALID_SUITE);
    expect(
      evaluationSuiteSchema.parse({
        label: "One case",
        arms: [{ label: "baseline", jobPatch: {} }],
        caseIds: ["bulk-discount-boundary"],
      }).repetitions,
    ).toBe(3);
  });

  it("rejects duplicate cases and arm labels", () => {
    expect(
      evaluationSuiteSchema.safeParse({
        ...VALID_SUITE,
        caseIds: ["bulk-discount-boundary", "bulk-discount-boundary"],
      }).success,
    ).toBe(false);
    expect(
      evaluationSuiteSchema.safeParse({
        ...VALID_SUITE,
        arms: [VALID_SUITE.arms[0], { label: "independent", jobPatch: { reviewMode: "none" } }],
      }).success,
    ).toBe(false);
  });

  it("rejects empty matrix dimensions, invalid repetitions, and unknown fields", () => {
    expect(evaluationSuiteSchema.safeParse({ ...VALID_SUITE, arms: [] }).success).toBe(false);
    expect(evaluationSuiteSchema.safeParse({ ...VALID_SUITE, caseIds: [] }).success).toBe(false);
    expect(evaluationSuiteSchema.safeParse({ ...VALID_SUITE, repetitions: 0 }).success).toBe(false);
    expect(evaluationSuiteSchema.safeParse({ ...VALID_SUITE, repetitions: 1.5 }).success).toBe(
      false,
    );
    expect(evaluationSuiteSchema.safeParse({ ...VALID_SUITE, id: "persisted-id" }).success).toBe(
      false,
    );
    expect(evaluationSuiteSchema.safeParse({ ...VALID_SUITE, createdAt: new Date() }).success).toBe(
      false,
    );
  });
});
