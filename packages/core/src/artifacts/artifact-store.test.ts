import type { Executor, NewJobArtifactRow } from "@rivet/database";
import { describe, expect, it, vi } from "vitest";

import { ArtifactTooLargeError, getArtifact, recordArtifact } from "./artifact-store";

/**
 * The writer's own rules, with no database.
 *
 * What is worth testing here is the part a caller cannot see: that the content
 * is bounded on the way in, and that `byteSize` describes what arrived rather
 * than what was stored. The two disagreeing is the whole reason the column is
 * kept separately, so a test that only checked the stored text would miss it.
 */

interface Capture {
  executor: Executor;
  values: NewJobArtifactRow[];
}

function capturingExecutor(): Capture {
  const values: NewJobArtifactRow[] = [];
  const executor = {
    insert: () => ({
      values: (row: NewJobArtifactRow) => {
        values.push(row);
        return { returning: () => Promise.resolve([{ ...row, id: 1, createdAt: new Date(0) }]) };
      },
    }),
  } as unknown as Executor;

  return { executor, values };
}

const INPUT = {
  jobId: "11111111-2222-3333-4444-555555555555",
  type: "diff",
  phase: "testing",
} as const;

describe("recordArtifact", () => {
  it("stores content under the bound untouched", async () => {
    const capture = capturingExecutor();

    const artifact = await recordArtifact(
      { ...INPUT, content: "diff --git a/a b/a\n", maxBytes: 1_024 },
      capture.executor,
    );

    expect(capture.values[0]?.content).toBe("diff --git a/a b/a\n");
    expect(artifact.truncated).toBe(false);
    expect(artifact.byteSize).toBe(19);
  });

  it("truncates content over the bound and still records the true size", async () => {
    const capture = capturingExecutor();
    const content = "x".repeat(5_000);

    const artifact = await recordArtifact({ ...INPUT, content, maxBytes: 100 }, capture.executor);

    const stored = capture.values[0]?.content ?? "";
    expect(stored.length).toBeLessThan(content.length);
    expect(stored).toContain("bytes elided");
    expect(artifact.truncated).toBe(true);
    // The size on the row is what arrived, not what survived. A 5000-byte diff
    // kept as 100 bytes is a fact a reader gets off the row without fetching.
    expect(artifact.byteSize).toBe(5_000);
    expect(artifact.byteSize).toBeGreaterThan(Buffer.byteLength(stored, "utf8"));
  });

  it("rejects a complete artifact instead of truncating it", async () => {
    const capture = capturingExecutor();

    await expect(
      recordArtifact(
        {
          ...INPUT,
          type: "implementation_plan",
          content: "x".repeat(101),
          maxBytes: 100,
          requireComplete: true,
        },
        capture.executor,
      ),
    ).rejects.toBeInstanceOf(ArtifactTooLargeError);
    expect(capture.values).toEqual([]);
  });

  it("counts the size in bytes rather than characters", async () => {
    const capture = capturingExecutor();

    const artifact = await recordArtifact(
      { ...INPUT, content: "héllo", maxBytes: 1_024 },
      capture.executor,
    );

    expect(artifact.byteSize).toBe(6);
  });

  it("omits metadata entirely when there is none", async () => {
    const capture = capturingExecutor();

    await recordArtifact({ ...INPUT, content: "", maxBytes: 1_024 }, capture.executor);

    expect(capture.values[0]).not.toHaveProperty("metadata");
  });

  it("passes metadata through for the types that carry structure", async () => {
    const capture = capturingExecutor();

    await recordArtifact(
      {
        ...INPUT,
        type: "diff_stat",
        content: "1 file changed",
        maxBytes: 1_024,
        metadata: { filesChanged: 1, insertions: 2, deletions: 3 },
      },
      capture.executor,
    );

    expect(capture.values[0]?.metadata).toEqual({ filesChanged: 1, insertions: 2, deletions: 3 });
  });

  it("refuses to invent a row when the insert returns nothing", async () => {
    const executor = {
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    } as unknown as Executor;

    await expect(
      recordArtifact({ ...INPUT, content: "", maxBytes: 1_024 }, executor),
    ).rejects.toThrow(/returned no row/);
  });
});

describe("getArtifact", () => {
  it("answers null for an id that could not be one, without querying", async () => {
    const select = vi.fn();
    const executor = { select } as unknown as Executor;

    expect(await getArtifact(INPUT.jobId, 0, executor)).toBeNull();
    expect(await getArtifact(INPUT.jobId, -3, executor)).toBeNull();
    expect(await getArtifact(INPUT.jobId, 1.5, executor)).toBeNull();
    expect(await getArtifact(INPUT.jobId, Number.MAX_SAFE_INTEGER + 2, executor)).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });
});
