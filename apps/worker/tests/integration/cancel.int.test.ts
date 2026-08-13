import {
  claimJob,
  requestJobCancellation,
  requestJobRun,
  simulatedPipeline,
  transitionJob,
} from "@rivet/core";
import { getPool } from "@rivet/database";
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
  TEST_CONFIG,
  type TestQueue,
  type TestWorker,
  waitFor,
  waitForStatus,
} from "./support";

/**
 * `requestJobCancellation`, which is two operations wearing one name.
 *
 * Every path through it needs a real database, which is why none of them had a
 * test before this file: the queued path is a compare-and-swap, the in-flight
 * path is a conditional `UPDATE` whose zero-row case is ambiguous by design,
 * and the interesting one is the race between them.
 */

let testQueue: TestQueue;
let worker: TestWorker | undefined;

beforeAll(() => {
  testQueue = createTestQueue("cancel");
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

describe("cancelling a job nobody has claimed", () => {
  it("cancels it outright and drops the queue message", async () => {
    const job = await createTestJob();
    await requestJobRun(job.id, testQueue.queue);
    expect(await testQueue.queue.bull.getJob(job.id)).toBeDefined();

    const result = await requestJobCancellation(job.id, testQueue.queue);

    expect(result.outcome).toBe("cancelled");
    const row = await readJob(job.id);
    expect(row.status).toBe("cancelled");
    expect(row.failureCategory).toBe("cancelled");
    expect(row.completedAt).not.toBeNull();
    expect(await testQueue.queue.bull.getJob(job.id)).toBeUndefined();
  });

  it("is a no-op the second time, and reports the job already finished", async () => {
    const job = await createTestJob();
    await requestJobCancellation(job.id, testQueue.queue);
    const before = await readEvents(job.id);

    const again = await requestJobCancellation(job.id, testQueue.queue);

    expect(again.outcome).toBe("already_terminal");
    expect(await readEvents(job.id)).toHaveLength(before.length);
  });

  it("returns not_found for an id that is not a job, without asking Postgres", async () => {
    // Postgres raises on a malformed uuid, and a 500 is the wrong answer to
    // "cancel the job named `../etc/passwd`".
    expect(await requestJobCancellation("../etc/passwd", testQueue.queue)).toEqual({
      outcome: "not_found",
    });
    expect(
      await requestJobCancellation("11111111-1111-4111-8111-111111111111", testQueue.queue),
    ).toEqual({ outcome: "not_found" });
  });
});

describe("cancelling a job a worker is holding", () => {
  it("records the request and lets the worker land it in cancelled", async () => {
    // Slow enough to still be running when the cancel arrives, fast enough that
    // the test is over in a couple of seconds.
    const job = await createTestJob();
    await requestJobRun(job.id, testQueue.queue);
    worker = startTestWorker({ queue: testQueue.queue, config: { pipelineSpeed: 0.08 } });

    // Wait until a worker genuinely owns it: cancelling before the claim would
    // be testing the other path.
    await waitFor(async () => (await readJob(job.id)).leaseOwner !== null, {
      label: "the job to be claimed",
    });

    const result = await requestJobCancellation(job.id, testQueue.queue);
    // Accepted, not completed: this process cannot stop the run, and saying
    // otherwise would be a lie the caller could act on.
    expect(result.outcome).toBe("cancel_requested");
    expect((await readJob(job.id)).cancelRequestedAt).not.toBeNull();

    const requestedAt = Date.now();
    const cancelled = await waitForStatus(job.id, "cancelled");
    expect(cancelled.failureCategory).toBe("cancelled");
    expect(cancelled.leaseOwner).toBeNull();
    expect(cancelled.completedAt).not.toBeNull();

    // Within a heartbeat, plus room for a round trip. Cancellation is delivered
    // on the same statement that renews the lease, so this interval is the only
    // thing between asking and stopping - there is no pub/sub and no poll of
    // its own.
    expect(Date.now() - requestedAt).toBeLessThan(TEST_CONFIG.heartbeatSeconds * 1_000 + 1_500);

    const events = await readEvents(job.id);
    const types = events.map((event) => event.type);

    // Abort is cooperative, so the phase that was in flight when the cancel
    // landed is allowed to finish its sentence - what must not happen is the
    // run carrying on afterwards. Nothing at all follows the cancellation.
    expect(types.at(-1)).toBe("job.status_changed");
    expect(events.at(-1)?.data?.to).toBe("cancelled");
    expect(types).toContain("job.cancel_requested");
    expect(types).not.toContain("job.completed");

    // And it genuinely stopped short rather than racing to the end and being
    // relabelled: fewer phases ran than the pipeline has.
    expect(types.filter((type) => type === "phase.started").length).toBeLessThan(
      simulatedPipeline().length,
    );
  });

  it("is idempotent while the worker is still winding down", async () => {
    const job = await createTestJob();
    await claimJob(job.id, "worker-a", 30);

    const first = await requestJobCancellation(job.id, testQueue.queue);
    const second = await requestJobCancellation(job.id, testQueue.queue);

    expect(first.outcome).toBe("cancel_requested");
    expect(second.outcome).toBe("cancel_requested");
    // The `cancel_requested_at IS NULL` predicate is what makes the second call
    // silent. A double-clicked cancel button is not worth a second timeline
    // entry.
    expect(
      (await eventTypes(job.id)).filter((type) => type === "job.cancel_requested"),
    ).toHaveLength(1);
  });
});

describe("the race between cancelling and claiming", () => {
  it("falls through to the cooperative path when a worker claims first", async () => {
    const job = await createTestJob();

    // The window this exercises is a single statement wide in production, so it
    // is held open deliberately: a separate connection takes the row lock, both
    // contenders queue up behind it, and Postgres grants the lock in the order
    // they asked. `requestJobCancellation` has already read `queued` by then,
    // so it commits to the outright-cancel path and then discovers, inside
    // `transitionJob`, that the job is no longer queued. That is the branch
    // where `cancelQueuedJob` returns `null` and the function falls through to
    // stamping a cooperative request instead.
    const holder = await getPool().connect();
    let claim: Promise<unknown> | undefined;
    let cancel: Promise<{ outcome: string }> | undefined;

    try {
      await holder.query("begin");
      await holder.query("select * from jobs where id = $1 for update", [job.id]);

      claim = claimJob(job.id, "worker-a", 30);
      await sleep(150);
      cancel = requestJobCancellation(job.id, testQueue.queue);
      await sleep(150);

      await holder.query("commit");
    } finally {
      holder.release();
    }

    expect(await claim).not.toBeNull();
    expect((await cancel)?.outcome).toBe("cancel_requested");

    const row = await readJob(job.id);
    expect(row.status).toBe("provisioning");
    expect(row.leaseOwner).toBe("worker-a");
    expect(row.cancelRequestedAt).not.toBeNull();
  });

  it("never both cancels and claims the same job", async () => {
    // The same race without the lock, run enough times to hit both orderings.
    // Whichever way it lands, the two outcomes have to agree: a cancelled job
    // was never claimed, and a claimed job was only ever asked to stop.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await resetDatabase();
      const job = await createTestJob();

      const [claimed, cancelled] = await Promise.all([
        claimJob(job.id, "worker-a", 30),
        requestJobCancellation(job.id, testQueue.queue),
      ]);

      const row = await readJob(job.id);
      if (cancelled.outcome === "cancelled") {
        expect(claimed).toBeNull();
        expect(row.status).toBe("cancelled");
      } else {
        expect(cancelled.outcome).toBe("cancel_requested");
        expect(claimed).not.toBeNull();
        expect(row.status).toBe("provisioning");
        expect(row.cancelRequestedAt).not.toBeNull();
      }
    }
  });
});

describe("cancelling a job that has already finished", () => {
  it("reports the status that made the request moot", async () => {
    const job = await createTestJob();
    await claimJob(job.id, "worker-a", 30);
    await transitionJob({
      jobId: job.id,
      from: "provisioning",
      to: "failed",
      leaseOwner: "worker-a",
      type: "job.failed",
      message: "Failed before the cancel arrived.",
      patch: { failureCategory: "unknown", leaseOwner: null, leaseExpiresAt: null },
    });

    const result = await requestJobCancellation(job.id, testQueue.queue);

    expect(result).toMatchObject({ outcome: "already_terminal" });
    expect((await readJob(job.id)).status).toBe("failed");
    expect(await eventTypes(job.id)).not.toContain("job.cancel_requested");
  });
});
