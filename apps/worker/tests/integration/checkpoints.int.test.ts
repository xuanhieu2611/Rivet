import { claimJob, getCheckpoint, getLatestCheckpoint, recordCheckpoint } from "@rivet/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeConnections, createTestJob, eventTypes, readEvents, resetDatabase } from "./support";

const PATCH = Buffer.from("diff --git a/example b/example\n");
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeConnections();
});

describe("checkpoint store", () => {
  it("allocates sequences and commits the checkpoint event with the row", async () => {
    const job = await createTestJob();
    const claimed = await claimJob(job.id, "worker-a", 30);
    expect(claimed).not.toBeNull();

    const first = await recordCheckpoint({
      jobId: job.id,
      attemptCount: claimed?.attemptCount ?? 1,
      kind: "agent_turn",
      agentTurn: 1,
      baseCommitSha: BASE_COMMIT,
      sandboxId: "sandbox-a",
      envFingerprint: { image: "fixture" },
      state: { version: 1, baselineEventId: 2 },
      patch: PATCH,
      maxBytes: 4_096,
      leaseOwner: "worker-a",
    });
    const second = await recordCheckpoint({
      jobId: job.id,
      attemptCount: claimed?.attemptCount ?? 1,
      kind: "phase_boundary",
      completedPhase: "planning",
      baseCommitSha: BASE_COMMIT,
      sandboxId: "sandbox-a",
      envFingerprint: { image: "fixture" },
      state: { version: 1, planArtifactId: 4 },
      patch: PATCH,
      maxBytes: 4_096,
      leaseOwner: "worker-a",
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(Buffer.from(second.restorePatch)).toEqual(PATCH);
    expect((await getLatestCheckpoint(job.id))?.id).toBe(second.id);
    expect((await getCheckpoint(job.id, first.id))?.resumePhase).toBe("implementing");
    expect((await eventTypes(job.id)).filter((type) => type === "checkpoint.created")).toHaveLength(
      2,
    );

    const before = await readEvents(job.id);
    await expect(
      recordCheckpoint({
        jobId: job.id,
        attemptCount: 1,
        kind: "agent_turn",
        agentTurn: 2,
        baseCommitSha: BASE_COMMIT,
        sandboxId: "sandbox-stale",
        envFingerprint: {},
        state: { version: 1 },
        patch: PATCH,
        maxBytes: 4_096,
        leaseOwner: "worker-stale",
      }),
    ).rejects.toThrow(/no longer leased/);
    expect(await readEvents(job.id)).toHaveLength(before.length);
  });
});
