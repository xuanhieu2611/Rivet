import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import type { JobEvent } from "@rivet/contracts";
import { getArtifact, listArtifacts, requestJobRun } from "@rivet/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  approvingReview,
  FakeCodingAgent,
  fixtureProvider,
  reviewPipeline,
  reviewerSession,
  reviewerWithoutVerdict,
  revisingReview,
  successfulSession,
} from "./review-fixture";
import {
  closeConnections,
  createTestJob,
  createTestQueue,
  eventTypes,
  readEvents,
  readJob,
  resetDatabase,
  startTestWorker,
  type TestQueue,
  type TestWorker,
  waitFor,
  waitForStatus,
} from "./support";

/**
 * Milestone 8's six acceptance runs through the production processor.
 *
 * Postgres, Redis, BullMQ, the lease and every phase context remain real. The
 * only scripted boundaries are the fake sandbox and fake coding agent, so the
 * suite can prove the durable review loop without a model key or Docker. The
 * real Docker reviewer path is a separate `*.sbx.test.ts` case.
 */

const REVIEW_CRASH_WORKER = resolve(import.meta.dirname, "review-crash-worker.ts");
const PROJECTED_TYPES = new Set([
  "job.created",
  "job.enqueued",
  "job.claimed",
  "phase.started",
  "phase.completed",
  "baseline.recorded",
  "validation.recorded",
  "plan.recorded",
  "review.recorded",
  "review.revision_requested",
  "review.limit_reached",
  "review.skipped",
  "checkpoint.created",
  "checkpoint.restored",
  "run.resumed",
  "run.summarized",
  "job.completed",
  "job.failed",
  "job.reclaimed",
]);

let testQueue: TestQueue;
let worker: TestWorker | undefined;
const children: ChildProcess[] = [];

beforeAll(() => {
  testQueue = createTestQueue("review", { backoff: { type: "fixed", delay: 20 } });
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
  await Promise.all(children.splice(0).map(stopChild));
});

function startReviewWorker(sandbox: ReturnType<typeof fixtureProvider>, agent: FakeCodingAgent) {
  worker = startTestWorker({
    queue: testQueue.queue,
    phases: reviewPipeline(sandbox, agent),
  });
}

async function runWithAgent(
  agent: FakeCodingAgent,
  overrides: Parameters<typeof createTestJob>[0] = {},
) {
  const job = await createTestJob(overrides);
  await requestJobRun(job.id, job.dispatchGeneration, testQueue.queue);
  startReviewWorker(fixtureProvider(), agent);
  return { job, finished: await waitForStatus(job.id, ["completed", "failed"]) };
}

function projected(events: readonly JobEvent[]): string[] {
  return events
    .filter((event) => {
      if (!PROJECTED_TYPES.has(event.type)) return false;
      // Turn checkpoints are intentionally not part of the acceptance trace.
      // The contract pins boundary checkpoints, while a session may capture
      // additional progress after each completed model turn.
      return event.type !== "checkpoint.created" || event.data?.completedPhase !== undefined;
    })
    .map((event) => event.type);
}

function phaseLabels(events: readonly JobEvent[]): string[] {
  return events
    .filter((event) => event.type === "phase.started")
    .map((event) => event.data?.phase)
    .filter((phase): phase is string => phase !== undefined);
}

function eventOf(events: readonly JobEvent[], type: string): JobEvent {
  const event = events.find((candidate) => candidate.type === type);
  if (!event) throw new Error(`Expected ${type} in the event log.`);
  return event;
}

function boundaryCheckpoint(events: readonly JobEvent[], completedPhase: string): JobEvent {
  const event = events.find(
    (candidate) =>
      candidate.type === "checkpoint.created" && candidate.data?.completedPhase === completedPhase,
  );
  if (!event) throw new Error(`Expected a ${completedPhase} boundary checkpoint.`);
  return event;
}

describe("Milestone 8 review acceptance contract", () => {
  it("A: approves on the first review loop", async () => {
    const agent = new FakeCodingAgent({
      script: [successfulSession("implementation")],
      reviewerScript: reviewerSession("review-approval", approvingReview()),
    });
    const { job, finished } = await runWithAgent(agent);

    expect(finished.status).toBe("completed");
    expect(finished.reviewMode).toBe("independent");
    expect(finished.maxReviewLoops).toBe(2);
    expect(finished.reviewLoops).toBe(0);
    expect(finished.reviewDecision).toBe("approve");
    expect(finished.reviewBlockingCount).toBe(0);
    expect(phaseLabels(await readEvents(job.id))).toEqual([
      "Provision sandbox",
      "Establish test baseline",
      "Create plan",
      "Implement change",
      "Validate change",
      "Review patch",
      "Finalize",
    ]);

    const events = await readEvents(job.id);
    expect(projected(events)).toEqual([
      "job.created",
      "job.enqueued",
      "job.claimed",
      "phase.started",
      "phase.completed",
      "phase.started",
      "baseline.recorded",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "plan.recorded",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "validation.recorded",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "review.recorded",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "run.summarized",
      "phase.completed",
      "job.completed",
    ]);

    expect(eventOf(events, "review.recorded").data).toMatchObject({
      reviewDecision: "approve",
      reviewLoop: 0,
      blockingCount: 0,
      nonBlockingCount: 0,
      confidence: 0.9,
    });
    expect(boundaryCheckpoint(events, "reviewing").data).toMatchObject({
      resumePhase: "finalizing",
    });
    expect(eventOf(events, "run.summarized").data).toMatchObject({
      reviewDecision: "approve",
      reviewLoops: 0,
    });
    expect(agent.starts.map((start) => start.role)).toEqual(["planner", "implementer", "reviewer"]);

    const reviewArtifacts = (await listArtifacts(job.id)).filter(
      (artifact) => artifact.type === "review_report",
    );
    expect(reviewArtifacts).toHaveLength(1);
    expect(await getArtifact(job.id, reviewArtifacts[0]!.id)).toMatchObject({
      content: JSON.stringify(approvingReview()),
    });
  });

  it("B: revises once, revalidates, then approves", async () => {
    const firstReview = revisingReview();
    const agent = new FakeCodingAgent({
      script: [successfulSession("implementation"), successfulSession("revision")],
      reviewerScript: [
        reviewerSession("review-revision", firstReview),
        reviewerSession("review-approval", approvingReview()),
      ],
    });
    const { job, finished } = await runWithAgent(agent);
    const events = await readEvents(job.id);

    expect(finished.status).toBe("completed");
    expect(finished.reviewLoops).toBe(1);
    expect(finished.reviewDecision).toBe("approve");
    expect(finished.reviewBlockingCount).toBe(0);
    expect(phaseLabels(events)).toEqual([
      "Provision sandbox",
      "Establish test baseline",
      "Create plan",
      "Implement change",
      "Validate change",
      "Review patch",
      "Revise change",
      "Validate change",
      "Review patch",
      "Finalize",
    ]);

    const firstReviewIndex = events.findIndex(
      (event) => event.type === "review.recorded" && event.data?.reviewLoop === 0,
    );
    expect(firstReviewIndex).toBeGreaterThanOrEqual(0);
    expect(projected(events).slice(projected(events).indexOf("review.recorded"))).toEqual([
      "review.recorded",
      "review.revision_requested",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "validation.recorded",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "review.recorded",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "run.summarized",
      "phase.completed",
      "job.completed",
    ]);
    expect(eventOf(events, "review.revision_requested").data).toMatchObject({
      reviewLoop: 0,
      reviewLoops: 1,
      maxReviewLoops: 2,
      blockingCount: 1,
    });
    expect(boundaryCheckpoint(events, "reviewing").data).toMatchObject({
      resumePhase: "revising",
    });
    expect(boundaryCheckpoint(events, "revising").data).toMatchObject({
      resumePhase: "testing",
    });
    expect(eventOf(events, "run.summarized").data).toMatchObject({
      reviewDecision: "approve",
      reviewLoops: 1,
    });

    const reviewerSpecs = agent.starts.filter((start) => start.role === "reviewer");
    expect(reviewerSpecs).toHaveLength(2);
    expect(reviewerSpecs[1]?.context).toContain(firstReview.summary);
    expect(
      (await eventTypes(job.id)).filter((type) => type === "validation.recorded"),
    ).toHaveLength(2);
    expect(
      (await listArtifacts(job.id)).filter((artifact) => artifact.type === "review_report"),
    ).toHaveLength(2);
  });

  it("C: fails with reviewer_rejection when the loop bound is exhausted", async () => {
    const agent = new FakeCodingAgent({
      script: [successfulSession("implementation"), successfulSession("revision")],
      reviewerScript: reviewerSession("review-reject", revisingReview()),
    });
    const { job, finished } = await runWithAgent(agent, { maxReviewLoops: 1 });
    const events = await readEvents(job.id);

    expect(finished.status).toBe("failed");
    expect(finished.failureCategory).toBe("reviewer_rejection");
    expect(finished.failureReason).toContain(revisingReview().summary);
    expect(finished.reviewLoops).toBe(1);
    expect(finished.reviewDecision).toBe("revise");
    expect(finished.reviewBlockingCount).toBe(1);
    expect(projected(events).slice(projected(events).indexOf("review.recorded"))).toEqual([
      "review.recorded",
      "review.revision_requested",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "validation.recorded",
      "checkpoint.created",
      "phase.completed",
      "phase.started",
      "review.recorded",
      "review.limit_reached",
      "job.failed",
    ]);
    expect(eventOf(events, "review.limit_reached").data).toMatchObject({
      reviewLoops: 1,
      maxReviewLoops: 1,
      blockingCount: 1,
      failureCategory: "reviewer_rejection",
    });
    expect(events.some((event) => event.type === "run.summarized")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "phase.completed" &&
          event.data?.phase === "Review patch" &&
          events.indexOf(event) >
            events.findIndex((candidate) => candidate.type === "review.limit_reached"),
      ),
    ).toBe(false);
    expect(
      (await listArtifacts(job.id)).filter((artifact) => artifact.type === "review_report"),
    ).toHaveLength(2);

    const message = await testQueue.queue.bull.getJob(`${job.id}.0`);
    expect(await message?.getState()).toBe("failed");
    expect(message?.attemptsMade).toBe(1);
  });

  it("D: reaches finalization while recording that review was skipped", async () => {
    const agent = new FakeCodingAgent({ script: [successfulSession("implementation")] });
    const { job, finished } = await runWithAgent(agent, { reviewMode: "none" });
    const events = await readEvents(job.id);

    expect(finished.status).toBe("completed");
    expect(finished.reviewMode).toBe("none");
    expect(finished.reviewLoops).toBe(0);
    expect(finished.reviewDecision).toBeNull();
    expect(finished.reviewBlockingCount).toBeNull();
    expect(phaseLabels(events)).not.toContain("Revise change");
    expect(projected(events)).toContain("review.skipped");
    expect(eventOf(events, "review.skipped").data).toEqual({ reviewMode: "none" });
    expect(eventOf(events, "run.summarized").data).toMatchObject({ reviewLoops: 0 });
    expect(eventOf(events, "run.summarized").data).not.toHaveProperty("reviewDecision");
    expect(events.some((event) => event.type === "review.recorded")).toBe(false);
    expect(agent.starts.some((start) => start.role === "reviewer")).toBe(false);
    expect(
      (await listArtifacts(job.id)).some((artifact) => artifact.type === "review_report"),
    ).toBe(false);
  });

  it("E: fails with review_not_produced when no verdict is submitted", async () => {
    const agent = new FakeCodingAgent({
      script: [successfulSession("implementation")],
      reviewerScript: reviewerWithoutVerdict(),
    });
    const { job, finished } = await runWithAgent(agent);
    const events = await readEvents(job.id);

    expect(finished.status).toBe("failed");
    expect(finished.failureCategory).toBe("review_not_produced");
    expect(finished.reviewLoops).toBe(0);
    expect(finished.reviewDecision).toBeNull();
    const reviewStartedIndex = events.findIndex(
      (event) => event.type === "phase.started" && event.data?.phase === "Review patch",
    );
    expect(projected(events.slice(reviewStartedIndex))).toEqual(["phase.started", "job.failed"]);
    expect(events.some((event) => event.type === "review.recorded")).toBe(false);
    expect(
      events.some(
        (event) => event.type === "phase.completed" && event.data?.phase === "Review patch",
      ),
    ).toBe(false);
    expect(
      (await listArtifacts(job.id)).some((artifact) => artifact.type === "review_report"),
    ).toBe(false);
    expect(agent.starts.filter((start) => start.role === "reviewer")).toHaveLength(1);
  });

  it("F: recovers a crash during revising without refunding the loop budget", async () => {
    const job = await createTestJob();
    await requestJobRun(job.id, job.dispatchGeneration, testQueue.queue);

    const workerA = startCrashWorker("review-crash-a", "interrupt");
    const reviewCheckpoint = await waitFor(
      async () => {
        const events = await readEvents(job.id);
        return (
          events.find(
            (event) =>
              event.type === "checkpoint.created" &&
              event.data?.completedPhase === "reviewing" &&
              event.data?.resumePhase === "revising",
          ) ?? null
        );
      },
      { timeoutMs: 30_000, label: "the reviewing checkpoint before revision" },
    );
    expect(reviewCheckpoint.data).toMatchObject({ resumePhase: "revising" });
    expect(await waitForChildExit(workerA)).toBe("SIGKILL");

    const workerB = startCrashWorker("review-crash-b", "finish");
    await waitFor(
      async () => {
        const events = await readEvents(job.id);
        const reclaimed = events.find((event) => event.type === "job.reclaimed");
        const row = await readJob(job.id);
        return reclaimed && row.attemptCount >= 2 ? row : null;
      },
      { timeoutMs: 30_000, label: "the revising attempt to be reclaimed" },
    ).then((row) => {
      expect(row.reviewLoops).toBe(1);
      expect(row.maxReviewLoops).toBe(2);
    });

    const finished = await waitForStatus(job.id, "completed", { timeoutMs: 30_000 });
    expect(finished.attemptCount).toBe(2);
    expect(finished.reviewLoops).toBe(1);
    expect(finished.reviewDecision).toBe("approve");

    const events = await readEvents(job.id);
    expect(
      events.some(
        (event) => event.type === "checkpoint.restored" && event.data?.resumePhase === "revising",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "run.resumed" && event.data?.resumePhase === "revising",
      ),
    ).toBe(true);
    expect(phaseLabels(events)).toContain("Revise change");
    expect(
      events.filter(
        (event) => event.type === "phase.started" && event.data?.phase === "Create plan",
      ),
    ).toHaveLength(1);

    // The replacement stays alive after the job completes and is stopped by the
    // normal cleanup hook, just like a production worker waiting for another
    // message.
    expect(workerB.exitCode).toBeNull();
  });
});

function startCrashWorker(workerId: string, mode: "interrupt" | "finish"): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", REVIEW_CRASH_WORKER, testQueue.queue.bull.name, workerId, mode],
    {
      cwd: resolve(import.meta.dirname, "../.."),
      detached: process.platform !== "win32",
      env: { ...process.env, RIVET_TEST_LOG_LEVEL: process.env.RIVET_TEST_LOG_LEVEL ?? "silent" },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  children.push(child);
  return child;
}

function waitForChildExit(child: ChildProcess): Promise<string | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.signalCode);
  }
  return new Promise((resolveExit) => {
    child.once("exit", (_code, signal) => resolveExit(signal));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  if (process.platform === "win32") child.kill("SIGKILL");
  else process.kill(-child.pid, "SIGKILL");
  await exited;
}
