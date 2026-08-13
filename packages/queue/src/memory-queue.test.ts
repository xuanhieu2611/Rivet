import { describe, expect, it } from "vitest";

import { InMemoryJobQueue } from "./memory-queue";

const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";

describe("InMemoryJobQueue", () => {
  it("records the payload of every enqueue", async () => {
    const queue = new InMemoryJobQueue();

    await queue.enqueueJobRun(JOB_A);
    await queue.enqueueJobRun(JOB_B, { delayMs: 5_000 });

    expect(queue.calls).toEqual([
      { jobId: JOB_A, options: {}, result: "enqueued" },
      { jobId: JOB_B, options: { delayMs: 5_000 }, result: "enqueued" },
    ]);
    expect(queue.enqueued).toEqual([JOB_A, JOB_B]);
  });

  it("dedupes by job id while a message is outstanding", async () => {
    const queue = new InMemoryJobQueue();

    expect(await queue.enqueueJobRun(JOB_A)).toBe("enqueued");
    expect(await queue.enqueueJobRun(JOB_A)).toBe("already-queued");

    // Both calls are recorded - the dedupe is visible, not silent - but only
    // one execution would ever happen.
    expect(queue.calls).toHaveLength(2);
    expect(queue.enqueued).toEqual([JOB_A]);
    expect(queue.pending).toEqual([JOB_A]);
  });

  it("lets an id be enqueued again once its message is drained", async () => {
    const queue = new InMemoryJobQueue();

    await queue.enqueueJobRun(JOB_A);
    expect(queue.drain()).toEqual([JOB_A]);
    expect(queue.pending).toEqual([]);

    // This is the retry and sweeper-reclaim path: the previous message is
    // finished, so the same job id may be enqueued for another attempt.
    expect(await queue.enqueueJobRun(JOB_A)).toBe("enqueued");
  });

  it("removes an outstanding message and reports whether there was one", async () => {
    const queue = new InMemoryJobQueue();

    await queue.enqueueJobRun(JOB_A);
    expect(await queue.removeJobRun(JOB_A)).toBe(true);
    expect(await queue.removeJobRun(JOB_A)).toBe(false);
    expect(queue.pending).toEqual([]);
  });

  it("tracks being closed", async () => {
    const queue = new InMemoryJobQueue();
    expect(queue.isClosed).toBe(false);
    await queue.close();
    expect(queue.isClosed).toBe(true);
  });
});
