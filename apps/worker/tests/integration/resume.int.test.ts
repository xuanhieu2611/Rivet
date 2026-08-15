import {
  claimJob,
  getLatestCheckpoint,
  recordCheckpoint,
  releaseJob,
  requestJobRun,
} from "@rivet/core";
import { db, jobCheckpoints } from "@rivet/database";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeConnections,
  createTestJob,
  createTestQueue,
  patchTestJob,
  readEvents,
  readJob,
  resetDatabase,
  startTestWorker,
  type TestQueue,
  type TestWorker,
  waitForStatus,
} from "./support";

/**
 * Which phases a claim runs, against a real database and a real worker.
 *
 * What this file covers is the half of recovery that is pure workflow: the
 * durable cursor is read after the claim, the pipeline becomes the suffix the
 * checkpoint names, the recovery transition edge out of `provisioning` is legal,
 * and `run.resumed` says so on the timeline. The suite runs with
 * `RIVET_SANDBOX=off`, so the phases are the simulated ones and no patch is
 * applied here - restoring and verifying a workspace is the sandbox suite's
 * subject, and the north-star `kill -9` run is Stage 10's.
 */

const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PATCH = Buffer.from("diff --git a/src/sum.ts b/src/sum.ts\n");

let testQueue: TestQueue;
let worker: TestWorker | undefined;

beforeAll(() => {
  testQueue = createTestQueue("resume");
});

afterAll(async () => {
  await testQueue.destroy();
  await closeConnections();
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

/**
 * A job that already has one durable checkpoint and is back in the queue.
 *
 * The lease is taken and handed back rather than faked, because a checkpoint
 * written without one is exactly what `recordCheckpoint` refuses.
 */
async function jobWithCheckpoint(input: {
  kind: "phase_boundary" | "agent_turn";
  completedPhase?: "analyzing" | "planning" | "implementing" | "testing";
  agentTurn?: number;
}) {
  const job = await createTestJob();
  const claimed = await claimJob(job.id, "worker-a", 30);
  expect(claimed).not.toBeNull();

  const checkpoint = await recordCheckpoint({
    jobId: job.id,
    attemptCount: claimed?.attemptCount ?? 1,
    kind: input.kind,
    ...(input.completedPhase ? { completedPhase: input.completedPhase } : {}),
    ...(input.agentTurn === undefined ? {} : { agentTurn: input.agentTurn }),
    baseCommitSha: BASE_COMMIT,
    sandboxId: "sandbox-a",
    envFingerprint: { image: "fixture" },
    state: { version: 1 },
    patch: PATCH,
    maxBytes: 4 * 1_024 * 1_024,
    leaseOwner: "worker-a",
  });

  await releaseJob(job.id, "worker-a", { reason: "Simulating a worker that went away." });
  await requestJobRun(job.id, testQueue.queue);
  return { job, checkpoint };
}

/** The phase labels the run actually walked, in order. */
async function phasesRun(jobId: string): Promise<(string | undefined)[]> {
  const events = await readEvents(jobId);
  return events.filter((event) => event.type === "phase.started").map((event) => event.data?.phase);
}

describe("resuming from a durable checkpoint", () => {
  it("runs the suffix a phase-boundary checkpoint names, and skips what it acknowledged", async () => {
    const { job, checkpoint } = await jobWithCheckpoint({
      kind: "phase_boundary",
      completedPhase: "planning",
    });

    worker = startTestWorker({ queue: testQueue.queue });
    await waitForStatus(job.id, "completed");

    // Provisioning still runs: an environment has to exist before a later phase
    // can be displayed truthfully. Analysis and planning do not, which is the
    // whole point - the baseline means "before Rivet edited anything", and a
    // second planning session would spend the budget again for a plan already
    // sitting in an artifact.
    expect(await phasesRun(job.id)).toEqual([
      "Provision sandbox",
      "Implement change",
      "Validate change",
      "Review patch",
      "Finalize",
    ]);

    const resumed = (await readEvents(job.id)).find((event) => event.type === "run.resumed");
    expect(resumed?.data).toMatchObject({
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.sequence,
      checkpointKind: "phase_boundary",
      completedPhase: "planning",
      resumePhase: "implementing",
      attempt: 2,
    });
  });

  it("starts a fresh implementation session after an interrupted turn", async () => {
    const { job } = await jobWithCheckpoint({ kind: "agent_turn", agentTurn: 2 });

    worker = startTestWorker({ queue: testQueue.queue });
    await waitForStatus(job.id, "completed");

    expect(await phasesRun(job.id)).toEqual([
      "Provision sandbox",
      "Implement change",
      "Validate change",
      "Review patch",
      "Finalize",
    ]);

    const resumed = (await readEvents(job.id)).find((event) => event.type === "run.resumed");
    expect(resumed?.data).toMatchObject({ resumePhase: "implementing", turn: 2 });
  });

  it("does not reset the durable review loop counter while resuming", async () => {
    const { job } = await jobWithCheckpoint({ kind: "phase_boundary", completedPhase: "planning" });
    await patchTestJob(job.id, { reviewLoops: 1, maxReviewLoops: 2 });

    worker = startTestWorker({ queue: testQueue.queue });
    await waitForStatus(job.id, "completed");

    const resumed = await readJob(job.id);
    expect(resumed.reviewLoops).toBe(1);
    expect(resumed.maxReviewLoops).toBe(2);
  });

  it("runs every phase when there is nothing to resume", async () => {
    const job = await createTestJob();
    await requestJobRun(job.id, testQueue.queue);

    worker = startTestWorker({ queue: testQueue.queue });
    await waitForStatus(job.id, "completed");

    expect(await phasesRun(job.id)).toHaveLength(7);
    expect((await readEvents(job.id)).some((event) => event.type === "run.resumed")).toBe(false);
  });

  it("captures no boundary checkpoint when the run has no workspace to snapshot", async () => {
    // `RIVET_SANDBOX=off` provisions nothing, so there is no working tree to
    // capture and no durability promise to keep. The skip is what lets the whole
    // lifecycle suite keep running without Docker; a real pipeline's boundaries
    // are covered by the sandbox suite.
    const { job } = await jobWithCheckpoint({ kind: "agent_turn", agentTurn: 2 });

    worker = startTestWorker({ queue: testQueue.queue });
    await waitForStatus(job.id, "completed");

    const rows = await db.select().from(jobCheckpoints).where(eq(jobCheckpoints.jobId, job.id));
    expect(rows).toHaveLength(1);
    expect((await getLatestCheckpoint(job.id))?.kind).toBe("agent_turn");
  });
});
