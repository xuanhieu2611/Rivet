import {
  benchmarkIdSchema,
  evaluationArmLabelSchema,
  evaluationFailureCategorySchema,
  evaluationRunSchema,
  failureLabelSourceSchema,
  runMetricsSchema,
  runResultSchema,
  type EvaluationRun,
} from "@rivet/contracts";
import {
  db,
  evaluationRuns,
  type EvaluationRunRow,
  type Executor,
  type NewEvaluationRunRow,
} from "@rivet/database";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

const evaluationRunIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Expected a UUID.");
const caseVersionHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 case version hash.");

/**
 * The persistence fields that surround the runner-facing EvaluationRun
 * contract. Keeping this strict means JSON metrics cannot quietly acquire a
 * second, unvalidated storage shape at the database boundary.
 */
const evaluationRunPersistenceInputSchema = z
  .object({
    suiteId: evaluationRunIdSchema,
    jobId: evaluationRunIdSchema.nullable().default(null),
    gradedAt: z.date().nullable().default(null),
    benchmarkId: benchmarkIdSchema,
    caseVersionHash: caseVersionHashSchema,
    arm: evaluationArmLabelSchema,
    repetition: z.number().int().positive(),
    result: runResultSchema,
    score: z.number().finite().min(0).max(1).nullable(),
    failureCategory: evaluationFailureCategorySchema.nullable(),
    failureLabelSource: failureLabelSourceSchema.nullable(),
    metrics: runMetricsSchema,
  })
  .strict();

export type CreateEvaluationRunInput = z.input<typeof evaluationRunPersistenceInputSchema>;

/** An evaluation result plus its database identities and timestamps. */
export type EvaluationRunRecord = EvaluationRun & {
  id: string;
  suiteId: string;
  jobId: string | null;
  gradedAt: Date | null;
  createdAt: Date;
};

const labelEvaluationRunInputSchema = z
  .object({
    id: evaluationRunIdSchema,
    failureCategory: evaluationFailureCategorySchema.nullable(),
    failureLabelSource: failureLabelSourceSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.failureCategory === null && value.failureLabelSource !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["failureLabelSource"],
        message: "A failure label source requires a failure category.",
      });
    }
    if (value.failureCategory !== null && value.failureLabelSource === null) {
      ctx.addIssue({
        code: "custom",
        path: ["failureLabelSource"],
        message: "A failure category requires a failure label source.",
      });
    }
  });

export type LabelEvaluationRunInput = z.input<typeof labelEvaluationRunInputSchema>;

/**
 * Writes the result for one case/arm/repetition cell.
 *
 * The runner writes only after the job has been graded, so this insert is
 * intentionally not an upsert. The unique matrix key turns an accidental
 * replay into a visible conflict instead of silently replacing history.
 */
export async function createEvaluationRun(
  input: CreateEvaluationRunInput,
  executor: Executor = db,
): Promise<EvaluationRunRecord> {
  const parsed = parseEvaluationRunInput(input);
  const values: NewEvaluationRunRow = {
    suiteId: parsed.suiteId,
    benchmarkId: parsed.benchmarkId,
    caseVersionHash: parsed.caseVersionHash,
    arm: parsed.arm,
    repetition: parsed.repetition,
    jobId: parsed.jobId,
    result: parsed.result,
    score: parsed.score === null ? null : String(parsed.score),
    failureCategory: parsed.failureCategory,
    failureLabelSource: parsed.failureLabelSource,
    metricsJson: parsed.metrics,
    gradedAt: parsed.gradedAt ?? new Date(),
  };

  const [row] = await executor.insert(evaluationRuns).values(values).returning();
  if (!row) {
    throw new Error(
      `Creating evaluation run ${parsed.benchmarkId}/${parsed.arm}/${parsed.repetition} returned no row.`,
    );
  }
  return toEvaluationRun(row);
}

/** Alias that emphasizes the append-only result ledger. */
export const recordEvaluationRun = createEvaluationRun;

/** Reads one run by id, or null for an invalid or unknown id. */
export async function getEvaluationRun(
  id: string,
  executor: Executor = db,
): Promise<EvaluationRunRecord | null> {
  const parsedId = evaluationRunIdSchema.safeParse(id);
  if (!parsedId.success) return null;

  const [row] = await executor
    .select()
    .from(evaluationRuns)
    .where(eq(evaluationRuns.id, parsedId.data))
    .limit(1);

  return row ? toEvaluationRun(row) : null;
}

/** Lists the runs in one suite in creation order. */
export async function listEvaluationRuns(
  suiteId: string,
  executor: Executor = db,
): Promise<EvaluationRunRecord[]> {
  const parsedSuiteId = evaluationRunIdSchema.safeParse(suiteId);
  if (!parsedSuiteId.success) return [];

  const rows = await executor
    .select()
    .from(evaluationRuns)
    .where(eq(evaluationRuns.suiteId, parsedSuiteId.data))
    .orderBy(asc(evaluationRuns.createdAt));
  return rows.map(toEvaluationRun);
}

/**
 * Applies a manual §24.5 label without changing the immutable grade or
 * metrics snapshot.
 */
export async function labelEvaluationRun(
  input: LabelEvaluationRunInput,
  executor: Executor = db,
): Promise<EvaluationRunRecord | null> {
  const parsed = labelEvaluationRunInputSchema.parse(input);
  const [row] = await executor
    .update(evaluationRuns)
    .set({
      failureCategory: parsed.failureCategory,
      failureLabelSource: parsed.failureLabelSource,
    })
    .where(eq(evaluationRuns.id, parsed.id))
    .returning();

  return row ? toEvaluationRun(row) : null;
}

/** Alias used by the labelling CLI. */
export const updateEvaluationRunLabel = labelEvaluationRun;

/**
 * Maps a stored row through the same strict schemas used for writes.
 *
 * PostgreSQL returns numeric columns as strings through node-postgres. Scores
 * are converted only at this boundary, while the exact cost string remains in
 * the metrics snapshot.
 */
export function toEvaluationRun(row: EvaluationRunRow): EvaluationRunRecord {
  const run = evaluationRunSchema.parse({
    benchmarkId: row.benchmarkId,
    caseVersionHash: row.caseVersionHash,
    arm: row.arm,
    repetition: row.repetition,
    result: row.result,
    score: parseStoredScore(row.score),
    failureCategory: row.failureCategory ?? null,
    failureLabelSource: row.failureLabelSource ?? null,
    metrics: row.metricsJson,
  });

  return {
    ...run,
    id: evaluationRunIdSchema.parse(row.id),
    suiteId: evaluationRunIdSchema.parse(row.suiteId),
    jobId: row.jobId ?? null,
    gradedAt: row.gradedAt === null ? null : z.date().parse(row.gradedAt),
    createdAt: z.date().parse(row.createdAt),
  };
}

/** Alias matching the other evaluation stores. */
export const toEvaluationRunRecord = toEvaluationRun;

function parseEvaluationRunInput(input: CreateEvaluationRunInput): CreateEvaluationRunInput {
  const parsed = evaluationRunPersistenceInputSchema.parse(input);
  const run = evaluationRunSchema.parse({
    benchmarkId: parsed.benchmarkId,
    caseVersionHash: parsed.caseVersionHash,
    arm: parsed.arm,
    repetition: parsed.repetition,
    result: parsed.result,
    score: parsed.score,
    failureCategory: parsed.failureCategory,
    failureLabelSource: parsed.failureLabelSource,
    metrics: parsed.metrics,
  });

  return {
    ...run,
    suiteId: parsed.suiteId,
    jobId: parsed.jobId,
    gradedAt: parsed.gradedAt,
  };
}

function parseStoredScore(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const numericValue = typeof value === "number" ? value : Number(value);
  return z.number().finite().min(0).max(1).parse(numericValue);
}
