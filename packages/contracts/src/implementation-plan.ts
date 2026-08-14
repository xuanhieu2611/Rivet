import { z } from "zod";

/**
 * Bounds for the structured plan that crosses the agent and persistence
 * boundaries. The limits are deliberately independent of the artifact store's
 * byte limit so the plan remains useful as a structured value.
 */
export const IMPLEMENTATION_PLAN_LIMITS = {
  problemInterpretationMaxChars: 4_000,
  itemMaxChars: 500,
  maxItemsPerSection: 12,
} as const;

const planText = (max: number) => z.string().trim().min(1).max(max);
const planItems = z
  .array(planText(IMPLEMENTATION_PLAN_LIMITS.itemMaxChars))
  .min(1)
  .max(IMPLEMENTATION_PLAN_LIMITS.maxItemsPerSection);

/**
 * The six sections a planner must submit. Strictness matters here: silently
 * accepting another field would make the persisted shape depend on whichever
 * model or adapter produced it.
 */
export const implementationPlanSchema = z
  .object({
    problemInterpretation: planText(IMPLEMENTATION_PLAN_LIMITS.problemInterpretationMaxChars),
    relevantComponents: planItems,
    reproductionStrategy: planItems,
    implementationApproach: planItems,
    validationPlan: planItems,
    riskAreas: planItems,
  })
  .strict();

export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;

export const IMPLEMENTATION_PLAN_SECTION_KEYS = [
  "problemInterpretation",
  "relevantComponents",
  "reproductionStrategy",
  "implementationApproach",
  "validationPlan",
  "riskAreas",
] as const satisfies readonly (keyof ImplementationPlan)[];

export type ImplementationPlanSectionKey = (typeof IMPLEMENTATION_PLAN_SECTION_KEYS)[number];

const IMPLEMENTATION_PLAN_SECTION_TITLES: Record<ImplementationPlanSectionKey, string> = {
  problemInterpretation: "Problem interpretation",
  relevantComponents: "Relevant components",
  reproductionStrategy: "Reproduction strategy",
  implementationApproach: "Implementation approach",
  validationPlan: "Validation plan",
  riskAreas: "Risk areas",
};

/** A stable, UI-friendly representation of the six plan sections. */
export interface RenderedImplementationPlanSection {
  key: ImplementationPlanSectionKey;
  title: string;
  items: readonly string[];
}

function normalizeImplementationPlan(value: unknown): ImplementationPlan {
  const parsed = implementationPlanSchema.parse(value);

  // Construct the object in schema order. JSON.stringify then has one canonical
  // representation regardless of the order supplied by the caller.
  return {
    problemInterpretation: parsed.problemInterpretation,
    relevantComponents: [...parsed.relevantComponents],
    reproductionStrategy: [...parsed.reproductionStrategy],
    implementationApproach: [...parsed.implementationApproach],
    validationPlan: [...parsed.validationPlan],
    riskAreas: [...parsed.riskAreas],
  };
}

/** Validates and normalizes a plan value before it crosses a boundary. */
export function parseImplementationPlan(value: unknown): ImplementationPlan {
  return normalizeImplementationPlan(value);
}

/** Serializes a validated plan into its canonical JSON representation. */
export function serializeImplementationPlan(value: unknown): string {
  return JSON.stringify(normalizeImplementationPlan(value));
}

/** Alias named after the property this function guarantees. */
export const canonicalizeImplementationPlan = serializeImplementationPlan;

/** Parses canonical JSON or any JSON string containing a valid plan. */
export function parseSerializedImplementationPlan(value: unknown): ImplementationPlan {
  if (typeof value !== "string") {
    throw new Error("Invalid implementation plan JSON: expected a string.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid implementation plan JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return normalizeImplementationPlan(parsed);
}

/**
 * Returns the plan in the order and shape used by the web renderer. The
 * interpretation is represented as a one-item section so every section can be
 * rendered with the same list component.
 */
export function renderImplementationPlan(value: unknown): RenderedImplementationPlanSection[] {
  const plan = normalizeImplementationPlan(value);

  return IMPLEMENTATION_PLAN_SECTION_KEYS.map((key) => ({
    key,
    title: IMPLEMENTATION_PLAN_SECTION_TITLES[key],
    items: key === "problemInterpretation" ? [plan[key]] : [...plan[key]],
  }));
}

/** Renders the plan as compact Markdown for logs, prompts, and text surfaces. */
export function renderImplementationPlanMarkdown(value: unknown): string {
  return renderImplementationPlan(value)
    .map((section) =>
      [`## ${section.title}`, ...section.items.map((item) => `- ${item}`)].join("\n"),
    )
    .join("\n\n");
}
