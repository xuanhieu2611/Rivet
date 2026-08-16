import {
  benchmarkCaseSchema,
  benchmarkIdSchema,
  type BenchmarkCase,
  type BenchmarkCategory,
  type BenchmarkDifficulty,
} from "@rivet/contracts";
import {
  benchmarkCases,
  db,
  type BenchmarkCaseRow,
  type Executor,
  type NewBenchmarkCaseRow,
} from "@rivet/database";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hex digest.");

/** The compact form used when the registry metadata is derived from `spec`. */
const derivedBenchmarkCaseRegistrySchema = z
  .object({
    versionHash: sha256Schema,
    baseCommitSha: z.string().trim().min(1),
    spec: benchmarkCaseSchema,
  })
  .strict();

/**
 * The expanded form is convenient for callers that already have the case
 * fields flattened for a dashboard row. Repeated metadata is checked against
 * the canonical `spec` before it reaches the database.
 */
const expandedBenchmarkCaseRegistrySchema = z
  .object({
    ...benchmarkCaseSchema.shape,
    versionHash: sha256Schema,
    baseCommitSha: z.string().trim().min(1),
    spec: benchmarkCaseSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.spec.id !== value.id) {
      ctx.addIssue({
        code: "custom",
        path: ["spec", "id"],
        message: "The case registry id must match spec.id.",
      });
    }
    if (value.spec.title !== value.title) {
      ctx.addIssue({
        code: "custom",
        path: ["spec", "title"],
        message: "The case registry title must match spec.title.",
      });
    }
    if (value.spec.category !== value.category) {
      ctx.addIssue({
        code: "custom",
        path: ["spec", "category"],
        message: "The case registry category must match spec.category.",
      });
    }
    if (value.spec.difficulty !== value.difficulty) {
      ctx.addIssue({
        code: "custom",
        path: ["spec", "difficulty"],
        message: "The case registry difficulty must match spec.difficulty.",
      });
    }
  });

const benchmarkCaseRegistrySchema = z.union([
  derivedBenchmarkCaseRegistrySchema,
  expandedBenchmarkCaseRegistrySchema,
]);

export type UpsertBenchmarkCaseInput = z.input<typeof benchmarkCaseRegistrySchema>;

interface NormalizedBenchmarkCase {
  id: string;
  versionHash: string;
  title: string;
  category: BenchmarkCategory;
  difficulty: BenchmarkDifficulty;
  baseCommitSha: string;
  spec: BenchmarkCase;
}

/** The database-backed registry entry returned to evaluation code. */
export interface BenchmarkCaseRecord extends NormalizedBenchmarkCase {
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Refreshes the benchmark registry entry for one checked-in case.
 *
 * `benchmark_cases` is intentionally the one evaluation table that is a cache:
 * the files under the benchmark root own the truth, so rebuilding a case
 * updates the snapshot instead of creating a second historical row.
 */
export async function upsertBenchmarkCase(
  input: UpsertBenchmarkCaseInput,
  executor: Executor = db,
): Promise<BenchmarkCaseRecord> {
  const parsed = normalizeBenchmarkCase(input);
  const values: NewBenchmarkCaseRow = {
    id: parsed.id,
    versionHash: parsed.versionHash,
    title: parsed.title,
    category: parsed.category,
    difficulty: parsed.difficulty,
    baseCommitSha: parsed.baseCommitSha,
    spec: parsed.spec,
  };

  const [row] = await executor
    .insert(benchmarkCases)
    .values(values)
    .onConflictDoUpdate({
      target: benchmarkCases.id,
      set: {
        versionHash: values.versionHash,
        title: values.title,
        category: values.category,
        difficulty: values.difficulty,
        baseCommitSha: values.baseCommitSha,
        spec: values.spec,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    throw new Error(`Upserting benchmark case ${parsed.id} returned no row.`);
  }
  return toBenchmarkCase(row);
}

/** Reads one registered benchmark case, or null for an invalid or unknown id. */
export async function getBenchmarkCase(
  id: string,
  executor: Executor = db,
): Promise<BenchmarkCaseRecord | null> {
  const parsedId = benchmarkIdSchema.safeParse(id);
  if (!parsedId.success) return null;

  const [row] = await executor
    .select()
    .from(benchmarkCases)
    .where(eq(benchmarkCases.id, parsedId.data))
    .limit(1);

  return row ? toBenchmarkCase(row) : null;
}

/** Lists the current benchmark registry in stable id order. */
export async function listBenchmarkCases(executor: Executor = db): Promise<BenchmarkCaseRecord[]> {
  const rows = await executor.select().from(benchmarkCases).orderBy(asc(benchmarkCases.id));
  return rows.map(toBenchmarkCase);
}

/** Validates and maps a database registry row to the domain shape. */
export function toBenchmarkCase(row: BenchmarkCaseRow): BenchmarkCaseRecord {
  const spec = benchmarkCaseSchema.parse(row.spec);
  const parsed = normalizeBenchmarkCase({
    ...spec,
    id: row.id,
    versionHash: row.versionHash,
    title: row.title,
    category: row.category,
    difficulty: row.difficulty,
    baseCommitSha: row.baseCommitSha,
    spec,
  });

  return {
    ...parsed,
    createdAt: z.date().parse(row.createdAt),
    updatedAt: z.date().parse(row.updatedAt),
  };
}

/** Alias matching the registry terminology used by callers. */
export const toBenchmarkCaseRecord = toBenchmarkCase;

function normalizeBenchmarkCase(input: unknown): NormalizedBenchmarkCase {
  const parsed = benchmarkCaseRegistrySchema.parse(input);
  const spec = parsed.spec;

  return {
    id: spec.id,
    versionHash: parsed.versionHash,
    title: spec.title,
    category: spec.category,
    difficulty: spec.difficulty,
    baseCommitSha: parsed.baseCommitSha,
    spec,
  };
}
