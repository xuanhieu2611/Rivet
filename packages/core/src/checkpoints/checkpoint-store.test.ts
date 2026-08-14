import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import type { Executor, JobCheckpointRow, NewJobCheckpointRow } from "@rivet/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { appendEvent } from "../events/event-service";
import {
  CheckpointCorruptError,
  CheckpointTooLargeError,
  recordCheckpoint,
  toRestorableCheckpoint,
  type RecordCheckpointInput,
  decompressCheckpointPatch,
  isLegalCheckpointResume,
  nextPhaseAfter,
  parseCheckpointState,
  resumePhaseForCheckpoint,
  sha256CheckpointPatch,
} from "./checkpoint-store";

vi.mock("../events/event-service", () => ({ appendEvent: vi.fn() }));

const JOB_ID = "11111111-2222-3333-4444-555555555555";
const PATCH = Buffer.from("diff --git a/src/example.ts b/src/example.ts\n");
const STATE = { version: 1 as const, baselineEventId: 3 };

function input(overrides: Partial<RecordCheckpointInput> = {}): RecordCheckpointInput {
  return {
    jobId: JOB_ID,
    attemptCount: 2,
    kind: "agent_turn",
    agentTurn: 4,
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    sandboxId: "sandbox-original",
    envFingerprint: { image: "node@sha256:test" },
    state: STATE,
    patch: PATCH,
    maxBytes: 4_096,
    leaseOwner: "worker-a",
    ...overrides,
  };
}

function rowFrom(values: NewJobCheckpointRow): JobCheckpointRow {
  return {
    id: 9,
    createdAt: new Date(0),
    ...values,
  } as JobCheckpointRow;
}

function capturingExecutor(): { executor: Executor; values: NewJobCheckpointRow[] } {
  const values: NewJobCheckpointRow[] = [];
  const owned = {
    leaseOwner: "worker-a",
    leaseExpiresAt: new Date(10_000),
    now: new Date(0),
  };
  let selectCount = 0;

  const executor = {
    select: () => {
      selectCount += 1;
      if (selectCount === 1) {
        return {
          from: () => ({
            where: () => ({
              limit: () => ({
                for: () => Promise.resolve([owned]),
              }),
            }),
          }),
        };
      }

      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      };
    },
    insert: () => ({
      values: (value: NewJobCheckpointRow) => {
        values.push(value);
        return {
          returning: () => Promise.resolve([rowFrom(value)]),
        };
      },
    }),
  } as unknown as Executor;

  vi.mocked(appendEvent).mockResolvedValue({} as Awaited<ReturnType<typeof appendEvent>>);

  return { executor, values };
}

describe("checkpoint state and phase mapping", () => {
  it("parses the v1 state and rejects unknown versions", () => {
    expect(parseCheckpointState({ version: 1, planArtifactId: 4 })).toEqual({
      version: 1,
      planArtifactId: 4,
    });
    expect(() => parseCheckpointState({ version: 2 })).toThrow(
      /Unsupported checkpoint state version/,
    );
    expect(() => parseCheckpointState({ version: 1, unexpected: true })).toThrow(
      CheckpointCorruptError,
    );
  });

  it("maps completed phases to the only legal suffix", () => {
    expect(nextPhaseAfter("analyzing")).toBe("planning");
    expect(nextPhaseAfter("implementing")).toBe("testing");
    expect(nextPhaseAfter("finalizing")).toBeNull();
    expect(resumePhaseForCheckpoint("agent_turn")).toBe("implementing");
    expect(resumePhaseForCheckpoint("phase_boundary", "planning")).toBe("implementing");
    expect(isLegalCheckpointResume("phase_boundary", "testing", "reviewing")).toBe(true);
    expect(isLegalCheckpointResume("phase_boundary", "testing", "planning")).toBe(false);
  });
});

describe("checkpoint patch integrity", () => {
  it("round-trips bytes through gzip and keeps the uncompressed checksum", () => {
    const compressed = gzipSync(PATCH);
    const restored = decompressCheckpointPatch(compressed, 1_024);

    expect(restored).toEqual(PATCH);
    expect(sha256CheckpointPatch(PATCH)).toBe(createHash("sha256").update(PATCH).digest("hex"));
  });

  it("bounds decompression before it can expose an oversized patch", () => {
    expect(() => decompressCheckpointPatch(gzipSync(Buffer.from("x".repeat(100))), 10)).toThrow(
      CheckpointTooLargeError,
    );
    expect(() => decompressCheckpointPatch(Buffer.from("not gzip"), 1_024)).toThrow(
      CheckpointCorruptError,
    );
  });

  it("rejects a row whose checksum or byte count does not match", () => {
    const compressed = gzipSync(PATCH);
    const base = rowFrom({
      jobId: JOB_ID,
      sequence: 1,
      attemptCount: 1,
      kind: "agent_turn",
      completedPhase: null,
      resumePhase: "implementing",
      agentTurn: 1,
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      sandboxId: "sandbox-original",
      envFingerprint: {},
      stateJson: STATE,
      patchFormat: "git_binary_full_index",
      patchCompression: "gzip",
      patchSha256: sha256CheckpointPatch(PATCH),
      patchByteSize: PATCH.byteLength,
      patchCompressedBytes: compressed.byteLength,
      patchPayload: compressed,
    });

    expect(toRestorableCheckpoint(base).restorePatch).toEqual(PATCH);
    expect(() => toRestorableCheckpoint({ ...base, patchSha256: "0".repeat(64) })).toThrow(
      CheckpointCorruptError,
    );
    expect(() => toRestorableCheckpoint({ ...base, patchByteSize: PATCH.byteLength + 1 })).toThrow(
      CheckpointCorruptError,
    );
  });
});

describe("recordCheckpoint", () => {
  beforeEach(() => {
    vi.mocked(appendEvent).mockReset();
  });

  it("allocates a per-job sequence and writes checkpoint metadata without patch content in the event", async () => {
    const capture = capturingExecutor();
    const checkpoint = await recordCheckpoint(input(), capture.executor);

    expect(checkpoint.sequence).toBe(1);
    expect(checkpoint.restorePatch).toEqual(PATCH);
    expect(capture.values[0]).toMatchObject({
      jobId: JOB_ID,
      sequence: 1,
      patchByteSize: PATCH.byteLength,
      patchSha256: sha256CheckpointPatch(PATCH),
      patchFormat: "git_binary_full_index",
      patchCompression: "gzip",
    });
    const eventInput = vi.mocked(appendEvent).mock.calls[0]?.[0];
    expect(eventInput?.type).toBe("checkpoint.created");
    expect(eventInput?.data).toMatchObject({
      checkpointId: 9,
      checkpointSequence: 1,
      checkpointKind: "agent_turn",
      resumePhase: "implementing",
      patchByteSize: PATCH.byteLength,
    });
    expect(vi.mocked(appendEvent).mock.calls[0]?.[1]).toBe(capture.executor);
    expect(JSON.stringify(eventInput)).not.toContain(PATCH.toString());
  });

  it("rejects the complete patch instead of truncating it", async () => {
    const capture = capturingExecutor();

    await expect(recordCheckpoint(input({ maxBytes: 4 }), capture.executor)).rejects.toThrow(
      CheckpointTooLargeError,
    );
    expect(capture.values).toHaveLength(0);
  });

  it("does not write after the lease has expired", async () => {
    const capture = capturingExecutor();
    const expired = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: () =>
                Promise.resolve([
                  {
                    leaseOwner: "worker-a",
                    leaseExpiresAt: new Date(0),
                    now: new Date(1),
                  },
                ]),
            }),
          }),
        }),
      }),
    } as unknown as Executor;

    await expect(recordCheckpoint(input(), expired)).rejects.toThrow(/no longer leased/);
    expect(capture.values).toHaveLength(0);
  });
});
