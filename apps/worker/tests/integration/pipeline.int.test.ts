import {
  abortableSleep,
  type Phase,
  requestJobRun,
  RetryableJobError,
  SIMULATED_PIPELINE,
  TerminalJobError,
} from "@rivet/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { FaultInjection } from "../../src/faults";
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
  waitForStatus,
} from "./support";

/**
 * A job going all the way through a real worker, and the three ways that ends
 * badly.
 *
 * The retry test is the reason this file overrides the queue's backoff. Five
 * seconds is the right production default and an unusable test default, and
 * changing it is a per-queue option rather than something the test reaches into
 * the adapter to patch.
 */

let testQueue: TestQueue;
let worker: TestWorker | undefined;

beforeAll(() => {
  testQueue = createTestQueue("pipeline", { backoff: { type: "fixed", delay: 100 } });
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

describe("happy path", () => {
  it("runs a job from queued to completed and records every phase", async () => {
    const job = await createTestJob();
    await requestJobRun(job.id, testQueue.queue);

    worker = startTestWorker({ queue: testQueue.queue });

    const finished = await waitForStatus(job.id, "completed");
    expect(finished.completedAt).not.toBeNull();
    expect(finished.startedAt).not.toBeNull();
    expect(finished.attemptCount).toBe(1);
    // The lease is cleared on the way out, so the sweeper never has to consider
    // a finished job at all.
    expect(finished.leaseOwner).toBeNull();
    expect(finished.leaseExpiresAt).toBeNull();

    const events = await readEvents(job.id);
    const types = events.map((event) => event.type);

    expect(types.slice(0, 3)).toEqual(["job.created", "job.enqueued", "job.claimed"]);
    expect(types.at(-1)).toBe("job.completed");

    // Every phase appears exactly once, started then completed, in order.
    const phaseLabels = events
      .filter((event) => event.type === "phase.started")
      .map((event) => event.data?.phase);
    expect(phaseLabels).toEqual(SIMULATED_PIPELINE.map((phase) => phase.label));
    expect(events.filter((event) => event.type === "phase.completed")).toHaveLength(
      SIMULATED_PIPELINE.length,
    );

    // The status the job passed through, in the order the timeline recorded.
    const visited = events
      .filter((event) => event.type === "phase.started" || event.type === "job.claimed")
      .map((event) => event.data?.to)
      .filter(Boolean);
    expect(visited[0]).toBe("provisioning");
  });
});

describe("idempotent enqueue", () => {
  it("runs once when the same job is enqueued twice", async () => {
    const job = await createTestJob();

    const first = await requestJobRun(job.id, testQueue.queue);
    const second = await requestJobRun(job.id, testQueue.queue);

    expect(first.result).toBe("enqueued");
    // The BullMQ job id is the job's own UUID, so the second message is not a
    // second message. This is what makes a retried `POST /api/jobs` safe.
    expect(second.result).toBe("already-queued");

    worker = startTestWorker({ queue: testQueue.queue });
    await waitForStatus(job.id, "completed");

    const types = await eventTypes(job.id);
    expect(types.filter((type) => type === "job.claimed")).toHaveLength(1);
    expect(types.filter((type) => type === "phase.started")).toHaveLength(
      SIMULATED_PIPELINE.length,
    );
    expect((await readJob(job.id)).attemptCount).toBe(1);
  });
});

describe("retryable failure", () => {
  it("returns the job to queued, retries it, and completes", async () => {
    const job = await createTestJob();
    await requestJobRun(job.id, testQueue.queue);

    // Fails the first attempt only. No environment variable could express
    // that, which is exactly why the fault arrives as a callback.
    let firstAttempt = true;
    const faults = (): FaultInjection => ({
      sleep: abortableSleep,
      fault: (phase: Phase) => {
        if (phase.status !== "testing" || !firstAttempt) return undefined;
        firstAttempt = false;
        return new RetryableJobError("Injected transient failure.");
      },
    });

    worker = startTestWorker({ queue: testQueue.queue, faults });

    const finished = await waitForStatus(job.id, "completed");
    // Postgres's counter, not BullMQ's: two claims, one per attempt.
    expect(finished.attemptCount).toBe(2);
    expect(finished.failureCategory).toBeNull();

    const types = await eventTypes(job.id);
    expect(types).toContain("job.retry_scheduled");
    expect(types.filter((type) => type === "job.claimed")).toHaveLength(2);
  });
});

describe("terminal failure", () => {
  it("fails once, persists the category, and is not retried", async () => {
    const job = await createTestJob();
    await requestJobRun(job.id, testQueue.queue);

    const faults = (): FaultInjection => ({
      sleep: abortableSleep,
      fault: (phase: Phase) =>
        phase.status === "implementing"
          ? new TerminalJobError("Injected terminal failure.", "simulated_failure")
          : undefined,
    });

    worker = startTestWorker({ queue: testQueue.queue, faults });

    const finished = await waitForStatus(job.id, "failed");
    expect(finished.failureCategory).toBe("simulated_failure");
    expect(finished.failureReason).toContain("Injected terminal failure");
    expect(finished.attemptCount).toBe(1);
    expect(finished.leaseOwner).toBeNull();

    const types = await eventTypes(job.id);
    expect(types).toContain("job.failed");
    expect(types).not.toContain("job.retry_scheduled");

    // BullMQ was told not to bother, via `UnrecoverableError` - the v6
    // replacement for `job.discard()`.
    const message = await testQueue.queue.bull.getJob(job.id);
    expect(await message?.getState()).toBe("failed");
    expect(message?.attemptsMade).toBe(1);
  });
});

describe("timeout", () => {
  it("lands a job that ignores its abort signal in timed_out", async () => {
    // One second of budget against a phase that never returns. `maxDuration` is
    // an integer column, so one second is as tight as this gets.
    const job = await createTestJob({ maxDurationSeconds: 1 });
    await requestJobRun(job.id, testQueue.queue);

    // The `hang` fault, expressed directly: a sleep that does not honour the
    // signal. Cooperative abort cannot rescue this run, which is the point -
    // the budget has to be a real deadline, not a polite request.
    const faults = (): FaultInjection => {
      let hanging = false;
      return {
        fault: (phase: Phase) => {
          hanging = phase.status === "analyzing";
          return undefined;
        },
        sleep: (ms, signal) =>
          hanging ? new Promise<void>(() => undefined) : abortableSleep(ms, signal),
      };
    };

    worker = startTestWorker({ queue: testQueue.queue, faults });

    const finished = await waitForStatus(job.id, "timed_out");
    expect(finished.failureCategory).toBe("timed_out");
    expect(finished.failureReason).toContain("budget");
    expect(finished.leaseOwner).toBeNull();

    // The run stopped where it hung, and no later phase was recorded.
    const types = await eventTypes(job.id);
    expect(types).not.toContain("job.completed");
    const started = (await readEvents(job.id))
      .filter((event) => event.type === "phase.started")
      .map((event) => event.data?.phase);
    expect(started).toEqual(["Provision sandbox", "Analyze repository"]);
  });
});
