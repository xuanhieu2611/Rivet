import { claimJob, heartbeat, reclaimExpiredJobs, transitionJob } from "@rivet/core";
import { TransitionConflictError } from "@rivet/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeConnections,
  createTestJob,
  createTestQueue,
  eventTypes,
  readEvents,
  readJob,
  resetDatabase,
  sleep,
  type TestQueue,
} from "./support";

/**
 * The lease protocol, against a real database.
 *
 * Everything here is about two processes disagreeing about who owns a job.
 * None of it can be tested without real concurrency and a real clock: the
 * whole mechanism is `SELECT ... FOR UPDATE` plus `now()`, and both are
 * properties of Postgres rather than of any code that could be mocked.
 */

let testQueue: TestQueue;

beforeAll(() => {
  testQueue = createTestQueue("claims");
});

afterAll(async () => {
  await testQueue.destroy();
  await closeConnections();
});

beforeEach(async () => {
  await resetDatabase();
});

describe("exclusive claim", () => {
  it("gives the job to exactly one of two workers racing for it", async () => {
    const job = await createTestJob();

    const [first, second] = await Promise.all([
      claimJob(job.id, "worker-a", 30),
      claimJob(job.id, "worker-b", 30),
    ]);

    const winners = [first, second].filter((result) => result !== null);
    expect(winners).toHaveLength(1);

    const row = await readJob(job.id);
    expect(row.status).toBe("provisioning");
    expect(["worker-a", "worker-b"]).toContain(row.leaseOwner);
    // One claim, so one increment. The loser wrote nothing at all.
    expect(row.attemptCount).toBe(1);
    expect((await eventTypes(job.id)).filter((type) => type === "job.claimed")).toHaveLength(1);
  });
});

describe("compare-and-swap", () => {
  it("rejects a transition from a status the job is not in, and writes no event", async () => {
    const job = await createTestJob();
    const before = await readEvents(job.id);

    // A legal edge in the guard table, but not from where this job actually is.
    // This is the stale-worker case: a process that believes the job is still
    // `implementing` when something else moved it.
    await expect(
      transitionJob({
        jobId: job.id,
        from: "implementing",
        to: "testing",
        message: "Should not happen.",
      }),
    ).rejects.toBeInstanceOf(TransitionConflictError);

    expect(await readEvents(job.id)).toHaveLength(before.length);
    expect((await readJob(job.id)).status).toBe("queued");
  });

  it("reports the status the job was really in", async () => {
    const job = await createTestJob();
    await claimJob(job.id, "worker-a", 30);

    try {
      await transitionJob({
        jobId: job.id,
        from: "queued",
        to: "provisioning",
        message: "Should not happen.",
      });
      expect.unreachable("the transition should have conflicted");
    } catch (error) {
      expect(error).toBeInstanceOf(TransitionConflictError);
      expect((error as TransitionConflictError).actualStatus).toBe("provisioning");
    }
  });
});

describe("heartbeat", () => {
  it("pushes the lease deadline forward and keeps the sweeper away", async () => {
    const job = await createTestJob();
    const claimed = await claimJob(job.id, "worker-a", 2);
    expect(claimed).not.toBeNull();

    const before = (await readJob(job.id)).leaseExpiresAt;
    await sleep(300);

    const result = await heartbeat(job.id, "worker-a", 2);
    expect(result).toEqual({ cancelRequested: false, status: "provisioning" });

    const after = (await readJob(job.id)).leaseExpiresAt;
    expect(after?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);

    // A live lease is invisible to the sweeper, which is the entire contract
    // between the two halves of this protocol.
    const reclaimed = await reclaimExpiredJobs(testQueue.queue, { maxAttempts: 3 });
    expect(reclaimed).toEqual([]);
    expect((await readJob(job.id)).status).toBe("provisioning");
  });

  it("returns null once the job belongs to somebody else", async () => {
    const job = await createTestJob();
    await claimJob(job.id, "worker-a", 30);

    // The fencing check, in its smallest form: the `lease_owner` predicate is
    // what a heartbeat is really asking about.
    expect(await heartbeat(job.id, "worker-b", 30)).toBeNull();
    expect(await heartbeat(job.id, "worker-a", 30)).not.toBeNull();
  });
});

describe("fencing", () => {
  it("stops a reclaimed worker from writing over its replacement", async () => {
    const job = await createTestJob();
    await claimJob(job.id, "worker-a", 1);

    // `kill -9` on worker A, as far as the database can tell: nothing released
    // the lease, so it simply runs out.
    await sleep(1_100);
    await reclaimExpiredJobs(testQueue.queue, { maxAttempts: 3 });

    const reclaimed = await claimJob(job.id, "worker-b", 30);
    expect(reclaimed).not.toBeNull();
    expect((await readJob(job.id)).leaseOwner).toBe("worker-b");

    const before = await readEvents(job.id);

    // Worker A wakes up and tries to carry on. The status is one it would
    // legitimately expect, and the transition is legal - the only thing that
    // stops it is the fencing token.
    await expect(
      transitionJob({
        jobId: job.id,
        from: "provisioning",
        to: "analyzing",
        leaseOwner: "worker-a",
        message: "Zombie write from a reclaimed worker.",
      }),
    ).rejects.toBeInstanceOf(TransitionConflictError);

    const row = await readJob(job.id);
    expect(row.status).toBe("provisioning");
    expect(row.leaseOwner).toBe("worker-b");
    // Not one byte of the rejected write reached the timeline either. A
    // conflicting transition and its event are the same transaction.
    expect(await readEvents(job.id)).toHaveLength(before.length);
  });
});
