import { serializeImplementationPlan, type JobArtifact } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { readImplementationPlanSections } from "@/lib/implementation-plan";

const PLAN = {
  problemInterpretation: "The retry helper never waits between attempts.",
  relevantComponents: ["src/retry.ts", "src/http-client.ts"],
  reproductionStrategy: ["Run the flaky client test"],
  implementationApproach: ["Add exponential backoff", "Cap the delay"],
  validationPlan: ["pnpm test"],
  riskAreas: ["Callers that assume immediate retries"],
};

function artifact(overrides: Partial<JobArtifact> = {}): JobArtifact {
  return {
    id: 12,
    jobId: "11111111-1111-4111-8111-111111111111",
    type: "implementation_plan",
    phase: "planning",
    content: serializeImplementationPlan(PLAN),
    byteSize: 256,
    truncated: false,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("readImplementationPlanSections", () => {
  it("returns the six sections in their canonical order", () => {
    const sections = readImplementationPlanSections(artifact());

    expect(sections?.map((section) => section.key)).toEqual([
      "problemInterpretation",
      "relevantComponents",
      "reproductionStrategy",
      "implementationApproach",
      "validationPlan",
      "riskAreas",
    ]);
    expect(sections?.[0]).toEqual({
      key: "problemInterpretation",
      title: "Problem interpretation",
      items: [PLAN.problemInterpretation],
    });
    expect(sections?.[1]?.items).toEqual(PLAN.relevantComponents);
  });

  it("reads nothing when no plan artifact exists", () => {
    expect(readImplementationPlanSections(null)).toBeNull();
  });

  it("refuses a truncated body rather than rendering half a plan", () => {
    expect(readImplementationPlanSections(artifact({ truncated: true }))).toBeNull();
  });

  it("degrades to nothing instead of throwing on an unreadable body", () => {
    expect(readImplementationPlanSections(artifact({ content: "not json" }))).toBeNull();
    expect(readImplementationPlanSections(artifact({ content: '{"version":2}' }))).toBeNull();
  });
});
