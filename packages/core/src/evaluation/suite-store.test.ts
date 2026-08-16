import type { EvaluationSuiteRow, Executor, NewEvaluationSuiteRow } from "@rivet/database";
import { describe, expect, it } from "vitest";

import {
  createEvaluationSuite,
  getEvaluationSuite,
  toEvaluationSuite,
  updateEvaluationSuiteStatus,
} from "./suite-store";

const SUITE_ID = "11111111-2222-3333-4444-555555555555";

const SUITE = {
  label: "review comparison",
  arms: [
    { label: "independent", jobPatch: { reviewMode: "independent" as const } },
    { label: "none", jobPatch: { reviewMode: "none" as const } },
  ],
  repetitions: 2,
  caseIds: ["bulk-discount-boundary", "stale-cache-key"],
};

function rowFrom(values: NewEvaluationSuiteRow): EvaluationSuiteRow {
  return {
    id: SUITE_ID,
    startedAt: new Date(0),
    completedAt: null,
    createdAt: new Date(0),
    ...values,
  } as EvaluationSuiteRow;
}

function capturingExecutor(initial?: EvaluationSuiteRow) {
  let current = initial;
  const inserted: NewEvaluationSuiteRow[] = [];
  const updates: Record<string, unknown>[] = [];
  const executor = {
    insert: () => ({
      values: (value: NewEvaluationSuiteRow) => {
        inserted.push(value);
        current = rowFrom(value);
        return { returning: () => Promise.resolve(current ? [current] : []) };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(current ? [current] : []) }),
        orderBy: () => Promise.resolve(current ? [current] : []),
      }),
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => {
        updates.push(value);
        current = current ? { ...current, ...value } : undefined;
        return {
          where: () => ({ returning: () => Promise.resolve(current ? [current] : []) }),
        };
      },
    }),
  } as unknown as Executor;

  return { executor, inserted, updates };
}

describe("createEvaluationSuite", () => {
  it("snapshots the validated matrix as a running suite", async () => {
    const capture = capturingExecutor();

    const stored = await createEvaluationSuite(SUITE, capture.executor);

    expect(capture.inserted).toEqual([{ ...SUITE, status: "running" }]);
    expect(stored).toEqual({
      ...SUITE,
      id: SUITE_ID,
      status: "running",
      startedAt: new Date(0),
      completedAt: null,
      createdAt: new Date(0),
    });
  });

  it("rejects unknown suite fields at the store boundary", async () => {
    const capture = capturingExecutor();

    await expect(
      createEvaluationSuite(
        { ...SUITE, unexpected: true } as unknown as typeof SUITE,
        capture.executor,
      ),
    ).rejects.toThrow();
    expect(capture.inserted).toHaveLength(0);
  });
});

describe("updateEvaluationSuiteStatus", () => {
  it("records a terminal timestamp when completing a suite", async () => {
    const initial = rowFrom({ ...SUITE, status: "running" });
    const capture = capturingExecutor(initial);

    const completed = await updateEvaluationSuiteStatus(
      { id: SUITE_ID, status: "completed" },
      capture.executor,
    );

    expect(capture.updates[0]).toMatchObject({ status: "completed" });
    expect(capture.updates[0]?.completedAt).toBeInstanceOf(Date);
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeInstanceOf(Date);
  });

  it("returns null for an unknown suite", async () => {
    const capture = capturingExecutor();
    expect(
      await updateEvaluationSuiteStatus(
        { id: SUITE_ID, status: "aborted", completedAt: new Date(0) },
        capture.executor,
      ),
    ).toBeNull();
  });
});

describe("toEvaluationSuite", () => {
  it("rejects an unknown persisted status", () => {
    expect(() => toEvaluationSuite(rowFrom({ ...SUITE, status: "paused" }))).toThrow();
  });
});

describe("getEvaluationSuite", () => {
  it("returns null for a malformed id", async () => {
    const capture = capturingExecutor();
    expect(await getEvaluationSuite("not-a-uuid", capture.executor)).toBeNull();
  });
});
