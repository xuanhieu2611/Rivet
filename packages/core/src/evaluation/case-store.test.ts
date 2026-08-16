import type { BenchmarkCaseRow, Executor, NewBenchmarkCaseRow } from "@rivet/database";
import { describe, expect, it } from "vitest";

import { getBenchmarkCase, toBenchmarkCase, upsertBenchmarkCase } from "./case-store";

const VERSION_HASH = "a".repeat(64);

const CASE = {
  id: "bulk-discount-boundary",
  title: "Fix the bulk discount boundary",
  category: "bug_fix" as const,
  difficulty: 1 as const,
  issue: "Ten items should qualify for the bulk discount.",
  setupCommand: null,
  validationCommand: ["node", "--test", "hidden/"],
  expectedBehavior: "The tenth item qualifies and the public suite stays green.",
  reviewMode: "independent" as const,
  maxCostUsd: "1.00",
  maxDurationSeconds: 900,
  commit: {
    author: "Rivet Benchmarks",
    email: "benchmarks@example.com",
    date: "2020-01-01T00:00:00Z",
  },
};

function rowFrom(values: NewBenchmarkCaseRow): BenchmarkCaseRow {
  return {
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...values,
  } as BenchmarkCaseRow;
}

function capturingExecutor(rows: BenchmarkCaseRow[] = []) {
  const inserted: NewBenchmarkCaseRow[] = [];
  const updates: Record<string, unknown>[] = [];
  const executor = {
    insert: () => ({
      values: (value: NewBenchmarkCaseRow) => {
        inserted.push(value);
        return {
          onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
            updates.push(config.set);
            return { returning: () => Promise.resolve([rowFrom(value)]) };
          },
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
        orderBy: () => Promise.resolve(rows),
      }),
    }),
  } as unknown as Executor;

  return { executor, inserted, updates };
}

describe("upsertBenchmarkCase", () => {
  it("validates and refreshes the registry snapshot", async () => {
    const capture = capturingExecutor();

    const stored = await upsertBenchmarkCase(
      {
        ...CASE,
        versionHash: VERSION_HASH,
        baseCommitSha: "b".repeat(40),
        spec: CASE,
      },
      capture.executor,
    );

    expect(capture.inserted).toEqual([
      {
        id: CASE.id,
        versionHash: VERSION_HASH,
        title: CASE.title,
        category: CASE.category,
        difficulty: CASE.difficulty,
        baseCommitSha: "b".repeat(40),
        spec: CASE,
      },
    ]);
    expect(capture.updates[0]).toMatchObject({ versionHash: VERSION_HASH });
    expect(stored).toEqual({
      id: CASE.id,
      title: CASE.title,
      category: CASE.category,
      difficulty: CASE.difficulty,
      versionHash: VERSION_HASH,
      baseCommitSha: "b".repeat(40),
      spec: CASE,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  });

  it("rejects registry metadata that disagrees with the case spec", async () => {
    const capture = capturingExecutor();

    await expect(
      upsertBenchmarkCase(
        {
          ...CASE,
          title: "A different title",
          versionHash: VERSION_HASH,
          baseCommitSha: "b".repeat(40),
          spec: CASE,
        },
        capture.executor,
      ),
    ).rejects.toThrow(/registry title/);
    expect(capture.inserted).toHaveLength(0);
  });
});

describe("getBenchmarkCase", () => {
  it("returns null before querying for an invalid benchmark id", async () => {
    const capture = capturingExecutor();
    expect(await getBenchmarkCase("../escape", capture.executor)).toBeNull();
  });

  it("maps a stored row through the strict case contract", async () => {
    const row = rowFrom({
      id: CASE.id,
      versionHash: VERSION_HASH,
      title: CASE.title,
      category: CASE.category,
      difficulty: CASE.difficulty,
      baseCommitSha: "b".repeat(40),
      spec: CASE,
    });
    const capture = capturingExecutor([row]);

    expect(await getBenchmarkCase(CASE.id, capture.executor)).toEqual({
      id: CASE.id,
      title: CASE.title,
      category: CASE.category,
      difficulty: CASE.difficulty,
      versionHash: VERSION_HASH,
      baseCommitSha: "b".repeat(40),
      spec: CASE,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  });

  it("rejects a corrupt stored row", () => {
    expect(() =>
      toBenchmarkCase(
        rowFrom({
          id: CASE.id,
          versionHash: VERSION_HASH,
          title: CASE.title,
          category: CASE.category,
          difficulty: CASE.difficulty,
          baseCommitSha: "b".repeat(40),
          spec: { ...CASE, difficulty: 2 },
        }),
      ),
    ).toThrow(/difficulty/);
  });
});
