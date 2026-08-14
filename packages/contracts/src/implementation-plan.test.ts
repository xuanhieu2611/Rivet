import { describe, expect, it } from "vitest";

import {
  IMPLEMENTATION_PLAN_LIMITS,
  implementationPlanSchema,
  parseImplementationPlan,
  parseSerializedImplementationPlan,
  renderImplementationPlan,
  serializeImplementationPlan,
} from "./implementation-plan";

const PLAN = {
  problemInterpretation: "  The request races with the existing write path.  ",
  relevantComponents: ["  booking service  ", "database constraint"],
  reproductionStrategy: ["Add a concurrent request test"],
  implementationApproach: ["Make the check and write atomic"],
  validationPlan: ["Run the focused test", "Run the full suite"],
  riskAreas: ["Existing duplicate records"],
};

describe("implementation plans", () => {
  it("trims every value and keeps exactly the six sections", () => {
    const parsed = parseImplementationPlan(PLAN);

    expect(parsed).toEqual({
      problemInterpretation: "The request races with the existing write path.",
      relevantComponents: ["booking service", "database constraint"],
      reproductionStrategy: ["Add a concurrent request test"],
      implementationApproach: ["Make the check and write atomic"],
      validationPlan: ["Run the focused test", "Run the full suite"],
      riskAreas: ["Existing duplicate records"],
    });
    expect(Object.keys(parsed)).toHaveLength(6);
  });

  it("rejects empty sections, extra sections, and overlong values", () => {
    expect(implementationPlanSchema.safeParse({ ...PLAN, riskAreas: [] }).success).toBe(false);
    expect(implementationPlanSchema.safeParse({ ...PLAN, unexpected: "field" }).success).toBe(
      false,
    );
    expect(
      implementationPlanSchema.safeParse({
        ...PLAN,
        problemInterpretation: "x".repeat(
          IMPLEMENTATION_PLAN_LIMITS.problemInterpretationMaxChars + 1,
        ),
      }).success,
    ).toBe(false);
    expect(
      implementationPlanSchema.safeParse({
        ...PLAN,
        relevantComponents: ["x".repeat(IMPLEMENTATION_PLAN_LIMITS.itemMaxChars + 1)],
      }).success,
    ).toBe(false);
  });

  it("serializes with stable key order and restores from JSON", () => {
    const serialized = serializeImplementationPlan(PLAN);

    expect(serialized).toBe(
      '{"problemInterpretation":"The request races with the existing write path.",' +
        '"relevantComponents":["booking service","database constraint"],' +
        '"reproductionStrategy":["Add a concurrent request test"],' +
        '"implementationApproach":["Make the check and write atomic"],' +
        '"validationPlan":["Run the focused test","Run the full suite"],' +
        '"riskAreas":["Existing duplicate records"]}',
    );
    expect(parseSerializedImplementationPlan(serialized)).toEqual(parseImplementationPlan(PLAN));
  });

  it("renders all six sections for the web surface", () => {
    expect(renderImplementationPlan(PLAN)).toEqual([
      {
        key: "problemInterpretation",
        title: "Problem interpretation",
        items: ["The request races with the existing write path."],
      },
      {
        key: "relevantComponents",
        title: "Relevant components",
        items: ["booking service", "database constraint"],
      },
      {
        key: "reproductionStrategy",
        title: "Reproduction strategy",
        items: ["Add a concurrent request test"],
      },
      {
        key: "implementationApproach",
        title: "Implementation approach",
        items: ["Make the check and write atomic"],
      },
      {
        key: "validationPlan",
        title: "Validation plan",
        items: ["Run the focused test", "Run the full suite"],
      },
      {
        key: "riskAreas",
        title: "Risk areas",
        items: ["Existing duplicate records"],
      },
    ]);
  });
});
