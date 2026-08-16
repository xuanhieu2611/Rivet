import { z } from "zod";

import { reviewModeSchema, type ReviewMode } from "./review-report";

/** The task categories named by PRD §24.1. */
export const BENCHMARK_CATEGORIES = [
  "bug_fix",
  "feature",
  "refactor",
  "test_generation",
  "concurrency",
  "api_change",
  "database_change",
] as const;

export const benchmarkCategorySchema = z.enum(BENCHMARK_CATEGORIES);

export type BenchmarkCategory = z.infer<typeof benchmarkCategorySchema>;

/** §32's complete difficulty ladder. M10's first five cases use levels 1 through 4. */
export const BENCHMARK_DIFFICULTY = {
  min: 1,
  max: 6,
} as const;

export const benchmarkDifficultySchema = z
  .number()
  .int()
  .min(BENCHMARK_DIFFICULTY.min)
  .max(BENCHMARK_DIFFICULTY.max);

export type BenchmarkDifficulty = z.infer<typeof benchmarkDifficultySchema>;

/** A case id is also a directory name, so it must be safe to resolve below the benchmark root. */
export const benchmarkIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Benchmark ids must use lowercase kebab-case.");

export type BenchmarkId = z.infer<typeof benchmarkIdSchema>;

/** A command is always an argv vector. Shell strings are intentionally not accepted. */
export const benchmarkCommandSchema = z.array(z.string().min(1)).min(1);

export type BenchmarkCommand = z.infer<typeof benchmarkCommandSchema>;

/** Non-negative decimal text keeps monetary values exact across JSON and Postgres numeric. */
export const nonNegativeDecimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, "Expected a non-negative decimal string.");

export type NonNegativeDecimalString = z.infer<typeof nonNegativeDecimalStringSchema>;

const isoDateStringSchema = z
  .string()
  .min(1)
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Commit date must be a valid ISO-compatible date.",
  );

export const benchmarkCommitSchema = z
  .object({
    author: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
    date: isoDateStringSchema,
  })
  .strict();

export type BenchmarkCommit = z.infer<typeof benchmarkCommitSchema>;

/**
 * The source-controlled description of one reproducible benchmark task.
 *
 * This is deliberately the case-file contract rather than a database row. The
 * fixture builder adds the derived version hash and base commit when it builds
 * the case, so neither belongs in `case.json` itself.
 */
export const benchmarkCaseSchema = z
  .object({
    id: benchmarkIdSchema,
    title: z.string().trim().min(1).max(200),
    category: benchmarkCategorySchema,
    difficulty: benchmarkDifficultySchema,
    issue: z.string().trim().min(1).max(10_000),
    setupCommand: benchmarkCommandSchema.nullable(),
    validationCommand: benchmarkCommandSchema,
    expectedBehavior: z.string().trim().min(1).max(10_000),
    reviewMode: reviewModeSchema,
    maxCostUsd: nonNegativeDecimalStringSchema,
    maxDurationSeconds: z.number().int().positive(),
    commit: benchmarkCommitSchema,
  })
  .strict();

export type BenchmarkCase = z.infer<typeof benchmarkCaseSchema>;
export type BenchmarkReviewMode = ReviewMode;
