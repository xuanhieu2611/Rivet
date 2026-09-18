import type { ArtifactType, JobArtifactSummary } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { formatDiffStats, latestDiffStats, readDiffStats } from "./diff-stats";

function artifact(
  id: number,
  type: ArtifactType,
  metadata: Record<string, unknown> | null,
): JobArtifactSummary {
  return {
    id,
    jobId: "00000000-0000-4000-8000-000000000000",
    type,
    phase: "testing",
    byteSize: 0,
    truncated: false,
    metadata,
    createdAt: new Date(id * 1_000),
  };
}

describe("readDiffStats", () => {
  it("reads the three counts", () => {
    expect(readDiffStats({ filesChanged: 3, insertions: 48, deletions: 12 })).toEqual({
      filesChanged: 3,
      insertions: 48,
      deletions: 12,
    });
  });

  it("refuses anything that is not three non-negative integers", () => {
    expect(readDiffStats(null)).toBeNull();
    expect(readDiffStats({})).toBeNull();
    expect(readDiffStats({ filesChanged: 3, insertions: 48 })).toBeNull();
    expect(readDiffStats({ filesChanged: -1, insertions: 0, deletions: 0 })).toBeNull();
    expect(readDiffStats({ filesChanged: 1.5, insertions: 0, deletions: 0 })).toBeNull();
    expect(readDiffStats({ filesChanged: "3", insertions: 0, deletions: 0 })).toBeNull();
  });
});

describe("latestDiffStats", () => {
  it("takes the newest diff_stat artifact and ignores every other type", () => {
    const artifacts = [
      artifact(1, "diff_stat", { filesChanged: 1, insertions: 1, deletions: 0 }),
      artifact(2, "diff", null),
      artifact(3, "diff_stat", { filesChanged: 9, insertions: 20, deletions: 4 }),
    ];

    expect(latestDiffStats(artifacts)).toEqual({
      filesChanged: 9,
      insertions: 20,
      deletions: 4,
    });
  });

  it("is null when no diff_stat exists or the newest one is unreadable", () => {
    expect(latestDiffStats([])).toBeNull();
    expect(latestDiffStats([artifact(1, "diff", null)])).toBeNull();
    expect(latestDiffStats([artifact(1, "diff_stat", { filesChanged: 1 })])).toBeNull();
  });
});

describe("formatDiffStats", () => {
  it("reads as a git summary line", () => {
    expect(formatDiffStats({ filesChanged: 3, insertions: 48, deletions: 12 })).toBe(
      "3 files changed, +48/-12",
    );
    expect(formatDiffStats({ filesChanged: 1, insertions: 0, deletions: 0 })).toBe(
      "1 file changed, +0/-0",
    );
  });
});
