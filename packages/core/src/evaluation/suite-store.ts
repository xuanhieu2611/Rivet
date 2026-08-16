import { evaluationSuiteSchema, type EvaluationArm, type EvaluationSuite } from "@rivet/contracts";
import {
  db,
  evaluationSuites,
  type EvaluationSuiteRow,
  type Executor,
  type NewEvaluationSuiteRow,
} from "@rivet/database";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

export const EVALUATION_SUITE_STATUSES = ["running", "completed", "aborted"] as const;

export const evaluationSuiteStatusSchema = z.enum(EVALUATION_SUITE_STATUSES);

export type EvaluationSuiteStatus = z.infer<typeof evaluationSuiteStatusSchema>;

const evaluationSuiteIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Expected a UUID.");

/** A suite definition plus the durable identity and lifecycle fields. */
export type EvaluationSuiteRecord = EvaluationSuite & {
  id: string;
  status: EvaluationSuiteStatus;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
};

export type CreateEvaluationSuiteInput = z.input<typeof evaluationSuiteSchema>;

const updateEvaluationSuiteStatusSchema = z
  .object({
    id: evaluationSuiteIdSchema,
    status: evaluationSuiteStatusSchema,
    completedAt: z.date().nullable().optional(),
  })
  .strict();

export type UpdateEvaluationSuiteStatusInput = z.input<typeof updateEvaluationSuiteStatusSchema>;

/**
 * Creates a running suite and snapshots its case matrix and arms.
 *
 * The runner owns suite lifecycle, so the store does not infer a status from a
 * job result. It starts every newly-created row explicitly as `running` and
 * exposes a separate status writer for the terminal update.
 */
export async function createEvaluationSuite(
  input: CreateEvaluationSuiteInput,
  executor: Executor = db,
): Promise<EvaluationSuiteRecord> {
  const parsed = evaluationSuiteSchema.parse(input);
  const values: NewEvaluationSuiteRow = {
    label: parsed.label,
    arms: parsed.arms,
    repetitions: parsed.repetitions,
    caseIds: parsed.caseIds,
    status: "running",
  };

  const [row] = await executor.insert(evaluationSuites).values(values).returning();
  if (!row) {
    throw new Error(`Creating evaluation suite ${parsed.label} returned no row.`);
  }
  return toEvaluationSuite(row);
}

/** Reads one suite by id, or null for an invalid or unknown id. */
export async function getEvaluationSuite(
  id: string,
  executor: Executor = db,
): Promise<EvaluationSuiteRecord | null> {
  const parsedId = evaluationSuiteIdSchema.safeParse(id);
  if (!parsedId.success) return null;

  const [row] = await executor
    .select()
    .from(evaluationSuites)
    .where(eq(evaluationSuites.id, parsedId.data))
    .limit(1);

  return row ? toEvaluationSuite(row) : null;
}

/** Lists suites newest first for the evaluation dashboard. */
export async function listEvaluationSuites(
  executor: Executor = db,
): Promise<EvaluationSuiteRecord[]> {
  const rows = await executor
    .select()
    .from(evaluationSuites)
    .orderBy(desc(evaluationSuites.createdAt));
  return rows.map(toEvaluationSuite);
}

/**
 * Moves a suite to its next lifecycle status.
 *
 * Terminal statuses receive a completion timestamp by default. Supplying null
 * explicitly is allowed for callers that are repairing a row before it starts.
 */
export async function updateEvaluationSuiteStatus(
  input: UpdateEvaluationSuiteStatusInput,
  executor: Executor = db,
): Promise<EvaluationSuiteRecord | null> {
  const parsed = updateEvaluationSuiteStatusSchema.parse(input);
  const completedAt =
    parsed.completedAt !== undefined
      ? parsed.completedAt
      : parsed.status === "running"
        ? null
        : new Date();

  const [row] = await executor
    .update(evaluationSuites)
    .set({ status: parsed.status, completedAt })
    .where(eq(evaluationSuites.id, parsed.id))
    .returning();

  return row ? toEvaluationSuite(row) : null;
}

/** Maps a row's JSON snapshots through the same strict suite contract. */
export function toEvaluationSuite(row: EvaluationSuiteRow): EvaluationSuiteRecord {
  const suite = evaluationSuiteSchema.parse({
    label: row.label,
    arms: row.arms,
    repetitions: row.repetitions,
    caseIds: row.caseIds,
  });

  return {
    ...suite,
    id: evaluationSuiteIdSchema.parse(row.id),
    status: evaluationSuiteStatusSchema.parse(row.status),
    startedAt: z.date().parse(row.startedAt),
    completedAt: row.completedAt === null ? null : z.date().parse(row.completedAt),
    createdAt: z.date().parse(row.createdAt),
  };
}

/** Alias matching the persistence terminology used by the other stores. */
export const toEvaluationSuiteRecord = toEvaluationSuite;

/** Keeps the public type visible to consumers that only need an arm snapshot. */
export type EvaluationSuiteArm = EvaluationArm;

/** Alias for callers that name the operation after the state transition. */
export const setEvaluationSuiteStatus = updateEvaluationSuiteStatus;

/** Stable id ordering helper for code that needs deterministic matrix output. */
export async function listEvaluationSuitesById(
  executor: Executor = db,
): Promise<EvaluationSuiteRecord[]> {
  const rows = await executor.select().from(evaluationSuites).orderBy(asc(evaluationSuites.id));
  return rows.map(toEvaluationSuite);
}
