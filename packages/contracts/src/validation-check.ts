import { z } from "zod";

import { validationOutcomeSchema, type ValidationOutcome } from "./job-event";

export const CHECK_KINDS = ["targeted_test", "test", "typecheck", "lint"] as const;

export const checkKindSchema = z.enum(CHECK_KINDS);
export type CheckKind = z.infer<typeof checkKindSchema>;

export const CHECK_STATUSES = ["passed", "failed", "skipped"] as const;

export const checkStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const CHECK_SOURCES = ["rivet_json", "package_json"] as const;

export const checkSourceSchema = z.enum(CHECK_SOURCES);
export type CheckSource = z.infer<typeof checkSourceSchema>;

export const TEST_FRAMEWORKS = ["vitest", "jest"] as const;

export const testFrameworkSchema = z.enum(TEST_FRAMEWORKS);
export type TestFramework = z.infer<typeof testFrameworkSchema>;

export const VALIDATION_REPORT_LIMITS = {
  maxFailureNames: 200,
  maxTargetedPaths: 200,
} as const;

const nonnegativeCountSchema = z.number().int().nonnegative();
const failureNamesSchema = z.array(z.string().min(1)).max(VALIDATION_REPORT_LIMITS.maxFailureNames);

export const testReportSchema = z
  .object({
    framework: testFrameworkSchema,
    total: nonnegativeCountSchema,
    passed: nonnegativeCountSchema,
    failed: nonnegativeCountSchema,
    skipped: nonnegativeCountSchema,
    failures: failureNamesSchema,
    parsed: z.boolean(),
  })
  .strict();

export type TestReport = z.infer<typeof testReportSchema>;

const checkRunShape = {
  kind: checkKindSchema,
  status: checkStatusSchema,
  source: checkSourceSchema,
  argv: z.array(z.string()).min(1).optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  commandId: z.number().int().positive().refine(Number.isSafeInteger).optional(),
  reason: z.string().min(1).optional(),
  tests: testReportSchema.optional(),
} as const;

function validateCheckRun(
  value: { status: CheckStatus; reason?: string | undefined },
  ctx: z.core.$RefinementCtx,
): void {
  if (value.status === "skipped" && value.reason === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: "A skipped check must include a reason.",
    });
  }
  if (value.status !== "skipped" && value.reason !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: "A check reason is only valid when the check is skipped.",
    });
  }
}

export const checkRunSchema = z.object(checkRunShape).strict().superRefine(validateCheckRun);

export type CheckRun = z.infer<typeof checkRunSchema>;

export const checkAttributionSchema = z
  .object({
    newFailures: failureNamesSchema,
    preExistingFailures: failureNamesSchema,
    fixedFailures: failureNamesSchema,
  })
  .strict();

export type CheckAttribution = z.infer<typeof checkAttributionSchema>;

export const checkComparisonSchema = z
  .object({
    ...checkRunShape,
    baseline: checkStatusSchema.nullable(),
    outcome: validationOutcomeSchema,
    attribution: checkAttributionSchema.optional(),
  })
  .strict()
  .superRefine(validateCheckRun);

export type CheckComparison = z.infer<typeof checkComparisonSchema>;

export const baselineReportSchema = z
  .object({
    checks: z.array(checkRunSchema),
  })
  .strict();

export type BaselineReport = z.infer<typeof baselineReportSchema>;

export const validationReportSchema = z
  .object({
    outcome: validationOutcomeSchema,
    checks: z.array(checkComparisonSchema),
    targetedPaths: z
      .array(z.string().min(1))
      .max(VALIDATION_REPORT_LIMITS.maxTargetedPaths)
      .optional(),
  })
  .strict();

export type ValidationReport = z.infer<typeof validationReportSchema>;

const OUTCOME_PRIORITY: Record<ValidationOutcome, number> = {
  verified: 0,
  fixed: 1,
  unverified: 2,
  unresolved: 3,
  regressed: 4,
};

/** Aggregates binding check outcomes into the job-level validation outcome. */
export function jobOutcomeFrom(
  checks: readonly Pick<CheckComparison, "kind" | "outcome">[],
): ValidationOutcome {
  let result: ValidationOutcome = "verified";
  let contributed = false;

  for (const check of checks) {
    if (check.kind === "targeted_test") continue;
    contributed = true;

    const outcome =
      check.kind !== "test" && check.outcome === "unresolved" ? "unverified" : check.outcome;
    if (OUTCOME_PRIORITY[outcome] > OUTCOME_PRIORITY[result]) result = outcome;
  }

  return contributed ? result : "unverified";
}

function normalizeTestReport(value: unknown): TestReport {
  const parsed = testReportSchema.parse(value);
  return {
    framework: parsed.framework,
    total: parsed.total,
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: parsed.skipped,
    failures: [...parsed.failures].sort(),
    parsed: parsed.parsed,
  };
}

function normalizeParsedCheckRun(parsed: CheckRun): CheckRun {
  return {
    kind: parsed.kind,
    status: parsed.status,
    source: parsed.source,
    ...(parsed.argv === undefined ? {} : { argv: [...parsed.argv] }),
    ...(parsed.exitCode === undefined ? {} : { exitCode: parsed.exitCode }),
    ...(parsed.durationMs === undefined ? {} : { durationMs: parsed.durationMs }),
    ...(parsed.commandId === undefined ? {} : { commandId: parsed.commandId }),
    ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    ...(parsed.tests === undefined ? {} : { tests: normalizeTestReport(parsed.tests) }),
  };
}

function normalizeCheckRun(value: unknown): CheckRun {
  return normalizeParsedCheckRun(checkRunSchema.parse(value));
}

function normalizeCheckComparison(value: unknown): CheckComparison {
  const parsed = checkComparisonSchema.parse(value);
  const run = normalizeParsedCheckRun(parsed);
  return {
    ...run,
    baseline: parsed.baseline,
    outcome: parsed.outcome,
    ...(parsed.attribution === undefined
      ? {}
      : {
          attribution: {
            newFailures: [...parsed.attribution.newFailures].sort(),
            preExistingFailures: [...parsed.attribution.preExistingFailures].sort(),
            fixedFailures: [...parsed.attribution.fixedFailures].sort(),
          },
        }),
  };
}

function parseJson(value: unknown, name: string): unknown {
  if (typeof value !== "string") throw new Error(`Invalid ${name} JSON: expected a string.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid ${name} JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function parseBaselineReport(value: unknown): BaselineReport {
  const parsed = baselineReportSchema.parse(value);
  return { checks: parsed.checks.map(normalizeCheckRun) };
}

export function serializeBaselineReport(value: unknown): string {
  return JSON.stringify(parseBaselineReport(value));
}

export const canonicalizeBaselineReport = serializeBaselineReport;

export function parseSerializedBaselineReport(value: unknown): BaselineReport {
  return parseBaselineReport(parseJson(value, "baseline report"));
}

export function parseValidationReport(value: unknown): ValidationReport {
  const parsed = validationReportSchema.parse(value);
  return {
    outcome: parsed.outcome,
    checks: parsed.checks.map(normalizeCheckComparison),
    ...(parsed.targetedPaths === undefined
      ? {}
      : { targetedPaths: [...parsed.targetedPaths].sort() }),
  };
}

export function serializeValidationReport(value: unknown): string {
  return JSON.stringify(parseValidationReport(value));
}

export const canonicalizeValidationReport = serializeValidationReport;

export function parseSerializedValidationReport(value: unknown): ValidationReport {
  return parseValidationReport(parseJson(value, "validation report"));
}
