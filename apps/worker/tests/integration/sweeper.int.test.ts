import {
  claimJob,
  reclaimExpiredJobs,
  requestJobCancellation,
  requeueOrphanedJobs,
  sweepJobs,
} from "@rivet/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeConnections,
  createTestJob,
  createTestQueue,
  eventTypes,
  readEvents,
  readJob,
  resetDatabase,
  sleep,
  startTestWorker,
  type TestQueue,
  type TestWorker,
  waitForStatus,
} from "./support";

/**
 * Crash recovery and dual-write reconciliation: the two claims the milestone is
 * actually making.
 *
 * The first test in this file is the automated version of the `kill -9` demo,
 * and it is the single most valuable test in the suite. Everything else in
 * Rivet has an obvious failure mode that shows up immediately; a job that
 * silently stops existing because its worker was killed at the wrong moment is
 * the one that would go unnoticed until a user asked where their job went.
 */

let testQueue: TestQueue;
let worker: TestWorker | undefined;

const SWEEP = { maxAttempts: 3, orphanedQueuedAfterMs: 0 } as const;

beforeAll(() => {
  testQueue = createTestQueue("sweeper");
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

describe("crash recovery", () => {
  it("reclaims a job whose worker vanished, and a second worker finishes it", async () => {
    const job = await createTestJob();
    // Keep the original delivery around. Reclaim must use a different encoded
    // message id rather than waiting for this generation to become stalled.
    await testQueue.queue.enqueueJobRun(job.id, 0);

    // What `kill -9` leaves behind, exactly: a claimed row, a lease with a
    // deadline on it, and nobody to renew it. No release, no failure, no event -
    // a killed process gets to say nothing at all, which is precisely why
    // BullMQ's own stalled detection cannot be the answer here. It knows a
    // message went quiet; it does not know this row exists.
    const claimed = await claimJob(job.id, "worker-that-died", 1);
    expect(claimed?.attemptCount).toBe(1);

    // Nothing can reclaim it while the lease is live, however dead the worker.
    expect(await reclaimExpiredJobs(testQueue.queue, SWEEP)).toEqual([]);

    await sleep(1_100);

    const results = await reclaimExpiredJobs(testQueue.queue, SWEEP);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      jobId: job.id,
      from: "provisioning",
      outcome: "reclaimed",
      leaseOwner: "worker-that-died",
    });

    const reclaimed = await readJob(job.id);
    expect(reclaimed.status).toBe("queued");
    expect(reclaimed.leaseOwner).toBeNull();
    expect(reclaimed.leaseExpiresAt).toBeNull();
    expect(reclaimed.dispatchGeneration).toBe(1);
    expect(await testQueue.queue.bull.getJob(`${job.id}.0`)).toBeDefined();
    expect(await testQueue.queue.bull.getJob(`${job.id}.1`)).toBeDefined();
    // Not bumped by the reclaim itself: the counter means "times a worker
    // picked this up", and the next claim is what does that.
    expect(reclaimed.attemptCount).toBe(1);
    // The original start time survives the crash, so end-to-end duration stays
    // honest across a reclaim.
    expect(reclaimed.startedAt).toEqual(claimed?.startedAt);

    const types = await eventTypes(job.id);
    expect(types).toContain("job.reclaimed");
    expect(types.at(-1)).toBe("job.enqueued");

    // And now the part that makes it recovery rather than bookkeeping: a fresh
    // worker picks up the re-enqueued message and takes the job to completion.
    worker = startTestWorker({ queue: testQueue.queue, workerId: "worker-that-lived" });

    const finished = await waitForStatus(job.id, "completed");
    expect(finished.attemptCount).toBe(2);
    expect(finished.failureCategory).toBeNull();
    expect((await eventTypes(job.id)).filter((type) => type === "job.claimed")).toHaveLength(2);
  });

  it("fails a job that has burned every attempt instead of reclaiming it forever", async () => {
    const job = await createTestJob();

    // Three claims, each one ending the same way: the worker stops answering.
    // A job that reliably kills its worker must not be allowed to keep doing
    // that to a fresh worker every sweep interval.
    let dispatchGeneration = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimJob(job.id, `worker-${attempt}`, 1, dispatchGeneration);
      expect(claimed?.attemptCount).toBe(attempt);
      await sleep(1_100);
      if (attempt < 3) {
        const results = await reclaimExpiredJobs(testQueue.queue, SWEEP);
        expect(results[0]?.outcome).toBe("reclaimed");
        dispatchGeneration += 1;
      }
    }

    const results = await reclaimExpiredJobs(testQueue.queue, SWEEP);
    expect(results[0]?.outcome).toBe("failed");

    const failed = await readJob(job.id);
    expect(failed.status).toBe("failed");
    // Nobody watched this job fail; its worker just stopped answering. Saying
    // so is more useful than guessing `unknown`.
    expect(failed.failureCategory).toBe("lease_expired");
    expect(failed.completedAt).not.toBeNull();
    expect(failed.leaseOwner).toBeNull();
    expect(await eventTypes(job.id)).toContain("job.failed");
  });

  it("honours a cancellation that the dead worker never got to act on", async () => {
    const job = await createTestJob();
    await claimJob(job.id, "worker-that-died", 1);
    await requestJobCancellation(job.id, testQueue.queue);

    await sleep(1_100);
    const results = await reclaimExpiredJobs(testQueue.queue, SWEEP);

    // Replaying the pipeline here would be actively wrong: someone asked for
    // this job to stop, and the only reason it did not is that its worker was
    // killed. The cooperative path exists because a live lease holder is the
    // only process allowed to end a running job - and there is no longer one.
    expect(results[0]?.outcome).toBe("cancelled");

    const cancelled = await readJob(job.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.failureCategory).toBe("cancelled");
    expect(cancelled.leaseOwner).toBeNull();

    // Nothing re-enqueued it, so no worker can pick it up again.
    expect(await testQueue.queue.bull.getJob(`${job.id}.0`)).toBeUndefined();
  });
});

describe("orphaned queued rows", () => {
  it("enqueues a committed row whose message never landed, and it completes", async () => {
    // The dual-write gap, reproduced exactly: the row is committed and no
    // message is sent. This is what a crash between the insert and the enqueue
    // leaves behind, and what an unreachable Redis leaves behind, and what a
    // flushed Redis leaves behind. All three look like this.
    const job = await createTestJob();
    expect(await testQueue.queue.bull.getJob(`${job.id}.0`)).toBeUndefined();

    const results = await requeueOrphanedJobs(testQueue.queue, SWEEP);
    expect(results).toEqual([{ jobId: job.id, outcome: "enqueued" }]);
    expect(await testQueue.queue.bull.getJob(`${job.id}.0`)).toBeDefined();

    const types = await eventTypes(job.id);
    expect(types).toEqual(["job.created", "job.enqueued"]);

    worker = startTestWorker({ queue: testQueue.queue });
    const finished = await waitForStatus(job.id, "completed");
    expect(finished.attemptCount).toBe(1);
  });

  it("says nothing and does nothing when the message was there all along", async () => {
    const job = await createTestJob();
    await testQueue.queue.enqueueJobRun(job.id, 0);
    const before = await readEvents(job.id);

    const results = await requeueOrphanedJobs(testQueue.queue, SWEEP);

    // Idempotent to the point of being uninteresting, which matters: this runs
    // against every waiting row once a minute forever, and an event per pass
    // would bury the timeline of a job that is merely waiting its turn.
    expect(results).toEqual([{ jobId: job.id, outcome: "already-queued" }]);
    expect(await readEvents(job.id)).toHaveLength(before.length);
  });

  it("leaves rows alone until they have been queued longer than the threshold", async () => {
    const job = await createTestJob();

    const results = await requeueOrphanedJobs(testQueue.queue, {
      maxAttempts: 3,
      orphanedQueuedAfterMs: 60_000,
    });

    expect(results).toEqual([]);
    expect(await testQueue.queue.bull.getJob(`${job.id}.0`)).toBeUndefined();
  });
});

describe("the scheduled sweep", () => {
  it("recovers an orphaned job with nobody driving it but the schedule", async () => {
    // Everything above calls the sweeper directly. This one proves the wiring
    // that makes it happen on its own: a BullMQ v6 Job Scheduler fires a `sweep`
    // message, the worker's processor recognises it by name, and the pass finds
    // a job nothing else was ever going to run.
    const job = await createTestJob();

    worker = startTestWorker({
      queue: testQueue.queue,
      withSweeper: true,
      config: { sweepIntervalMs: 1_000 },
    });
    await testQueue.queue.scheduleSweeps(1_000);

    try {
      const finished = await waitForStatus(job.id, "completed", { timeoutMs: 20_000 });
      expect(finished.attemptCount).toBe(1);
      expect(await eventTypes(job.id)).toContain("job.enqueued");
    } finally {
      // The schedule lives in Redis, not in the worker, so it outlives the
      // process unless something removes it. `obliterate` in teardown would too,
      // but leaving a scheduler running against a queue a later test reuses is
      // the kind of thing that produces a mystery.
      await testQueue.queue.unscheduleSweeps();
    }
  });
});

describe("a full sweep", () => {
  it("reports both halves in one pass", async () => {
    const stranded = await createTestJob({ title: "stranded" });
    const orphaned = await createTestJob({ title: "orphaned" });

    await claimJob(stranded.id, "worker-that-died", 1);
    await sleep(1_100);

    const report = await sweepJobs(testQueue.queue, SWEEP);

    expect(report.expiredLeases.map((result) => result.jobId)).toEqual([stranded.id]);
    expect(report.orphanedQueued).toContainEqual({ jobId: orphaned.id, outcome: "enqueued" });
    // The job the first half just reclaimed is back in `queued`, so the second
    // half looks at it too - and finds the message the reclaim already sent.
    // The two halves overlapping is harmless by construction rather than by
    // careful ordering, which is what makes the sweep safe to run twice.
    expect(report.orphanedQueued).toContainEqual({ jobId: stranded.id, outcome: "already-queued" });
  });
});
