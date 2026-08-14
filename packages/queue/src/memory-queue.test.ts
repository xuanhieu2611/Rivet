import { describe, expect, it } from "vitest";

import { InMemoryJobQueue } from "./memory-queue";

const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";

describe("InMemoryJobQueue", () => {
  it("records the payload of every enqueue", async () => {
    const queue = new InMemoryJobQueue();

    await queue.enqueueJobRun(JOB_A, 0);
    await queue.enqueueJobRun(JOB_B, 0, { delayMs: 5_000 });

    expect(queue.calls).toEqual([
      { jobId: JOB_A, dispatchGeneration: 0, options: {}, result: "enqueued" },
      {
        jobId: JOB_B,
        dispatchGeneration: 0,
        options: { delayMs: 5_000 },
        result: "enqueued",
      },
    ]);
    expect(queue.enqueued).toEqual([`${JOB_A}.0`, `${JOB_B}.0`]);
  });

  it("dedupes by encoded generation while a message is outstanding", async () => {
    const queue = new InMemoryJobQueue();

    expect(await queue.enqueueJobRun(JOB_A, 0)).toBe("enqueued");
    expect(await queue.enqueueJobRun(JOB_A, 0)).toBe("already-queued");

    // Both calls are recorded - the dedupe is visible, not silent - but only
    // one execution would ever happen.
    expect(queue.calls).toHaveLength(2);
    expect(queue.enqueued).toEqual([`${JOB_A}.0`]);
    expect(queue.pending).toEqual([`${JOB_A}.0`]);
  });

  it("allows a new generation while the previous one is still outstanding", async () => {
    const queue = new InMemoryJobQueue();

    await queue.enqueueJobRun(JOB_A, 0);
    expect(await queue.enqueueJobRun(JOB_A, 1)).toBe("enqueued");
    expect(queue.pending).toEqual([`${JOB_A}.0`, `${JOB_A}.1`]);
  });

  it("lets a generation be enqueued again once its message is drained", async () => {
    const queue = new InMemoryJobQueue();

    await queue.enqueueJobRun(JOB_A, 0);
    expect(queue.drain()).toEqual([`${JOB_A}.0`]);
    expect(queue.pending).toEqual([]);

    // This is the retry and sweeper-reclaim path: the previous message is
    // finished, so the same generation may be enqueued for another delivery.
    expect(await queue.enqueueJobRun(JOB_A, 0)).toBe("enqueued");
  });

  it("removes an outstanding message and reports whether there was one", async () => {
    const queue = new InMemoryJobQueue();

    await queue.enqueueJobRun(JOB_A, 0);
    expect(await queue.removeJobRun(JOB_A, 0)).toBe(true);
    expect(await queue.removeJobRun(JOB_A, 0)).toBe(false);
    expect(queue.pending).toEqual([]);
  });

  it("tracks being closed", async () => {
    const queue = new InMemoryJobQueue();
    expect(queue.isClosed).toBe(false);
    await queue.close();
    expect(queue.isClosed).toBe(true);
  });
});
