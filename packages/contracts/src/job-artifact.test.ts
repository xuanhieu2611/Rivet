import { describe, expect, it } from "vitest";

import {
  parseSerializedJobArtifact,
  parseSerializedJobArtifactSummary,
  serializeJobArtifact,
  serializeJobArtifactSummary,
  type JobArtifact,
} from "./job-artifact";

const ARTIFACT: JobArtifact = {
  id: 3,
  jobId: "11111111-2222-3333-8444-555555555555",
  type: "diff",
  phase: "testing",
  content: "diff --git a/src/discount.js b/src/discount.js\n",
  byteSize: 47,
  truncated: false,
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("serialized job artifacts", () => {
  it("serializes and restores artifact dates", () => {
    const serialized = serializeJobArtifact(ARTIFACT);

    expect(serialized.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(parseSerializedJobArtifact(serialized)).toEqual(ARTIFACT);
  });

  it("keeps the true byte size apart from the stored content", () => {
    // The whole reason `byteSize` is a column: a truncated artifact is one
    // where these two disagree, and a reader has to be able to see that
    // without fetching the content.
    const truncated: JobArtifact = {
      ...ARTIFACT,
      content: "head\n...[eliding 4,096 bytes]...\ntail\n",
      byteSize: 4_200,
      truncated: true,
    };

    const parsed = parseSerializedJobArtifact(serializeJobArtifact(truncated));

    expect(parsed.byteSize).toBe(4_200);
    expect(parsed.truncated).toBe(true);
    expect(parsed.content.length).toBeLessThan(parsed.byteSize);
  });

  it("round-trips metadata on a diff stat", () => {
    const stat: JobArtifact = {
      ...ARTIFACT,
      type: "diff_stat",
      content: "1\t1\tsrc/discount.js\n",
      metadata: { filesChanged: 1, insertions: 1, deletions: 1 },
    };

    expect(parseSerializedJobArtifact(serializeJobArtifact(stat))).toEqual(stat);
  });

  it.each(["baseline_report", "validation_report"] as const)(
    "round-trips the %s artifact vocabulary",
    (type) => {
      const artifact = { ...ARTIFACT, type };
      expect(parseSerializedJobArtifact(serializeJobArtifact(artifact))).toEqual(artifact);
    },
  );

  it("drops content from a summary and still validates", () => {
    const { content: _content, ...summary } = ARTIFACT;

    const serialized = serializeJobArtifactSummary(summary);

    expect(serialized).not.toHaveProperty("content");
    expect(parseSerializedJobArtifactSummary(serialized)).toEqual(summary);
  });

  it("rejects an unknown type, a bad phase, and a malformed id or date", () => {
    const serialized = serializeJobArtifact(ARTIFACT);

    expect(() => parseSerializedJobArtifact({ ...serialized, type: "screenshot" })).toThrow();
    expect(() => parseSerializedJobArtifact({ ...serialized, phase: "validating" })).toThrow();
    expect(() => parseSerializedJobArtifact({ ...serialized, id: 0 })).toThrow();
    expect(() => parseSerializedJobArtifact({ ...serialized, createdAt: "nope" })).toThrow();
    expect(() => parseSerializedJobArtifact({ ...serialized, byteSize: -1 })).toThrow();
  });
});
