import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { getLatestCheckpoint, requestJobRun } from "@rivet/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeConnections,
  createTestJob,
  createTestQueue,
  MILESTONE_6_RECOVERY_EVENT_SEQUENCE,
  readEvents,
  readJob,
  recoveryEventKey,
  resetDatabase,
  type TestQueue,
  waitFor,
  waitForStatus,
} from "./support";

/**
 * The Milestone 6 acceptance contract, and the crash it was written for.
 *
 * The first two cases assert the trace itself, which is what stopped the
 * intervening stages from proving a simpler "retry from provisioning" workflow
 * and calling it recovery. The third is the run: a worker in its own process,
 * killed with `SIGKILL` after its progress is durable, and a second process
 * that finishes the job from the cursor the first one left.
 *
 * What this file cannot prove is that the restored *bytes* are right: it runs
 * under `RIVET_SANDBOX=off`, where there is no working tree to snapshot, so the
 * child writes its checkpoint from the phase rather than capturing one. The
 * sandbox suite proves capture and application across two real containers, and
 * `pnpm demo:recovery` proves the whole thing at once. Splitting it this way is
 * what keeps CI's integration job on Postgres and Redis alone.
 */

const CHILD = resolve(import.meta.dirname, "crash-worker.ts");

let testQueue: TestQueue;
const children: ChildProcess[] = [];

beforeAll(() => {
  testQueue = createTestQueue("crash");
});

afterAll(async () => {
  await testQueue.destroy();
  await closeConnections();
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
});

describe("Milestone 6 recovery acceptance contract", () => {
  it("records the phase, attempt, generation and checkpoint distinctions", () => {
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE[0]).toBe("job.created");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("job.claimed:attempt-1");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("job.claimed:attempt-2");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("job.enqueued:generation-0");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("job.enqueued:generation-1");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("checkpoint.created:phase_boundary");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("checkpoint.created:agent_turn");
    expect(
      MILESTONE_6_RECOVERY_EVENT_SEQUENCE.filter(
        (entry) => entry === "phase.started:Establish test baseline",
      ),
    ).toHaveLength(1);
    expect(
      MILESTONE_6_RECOVERY_EVENT_SEQUENCE.filter((entry) => entry === "phase.started:Create plan"),
    ).toHaveLength(1);
  });

  it("keys phase and generation details without depending on future contracts", () => {
    expect(
      recoveryEventKey({
        type: "phase.started",
        data: { phase: "Provision sandbox" },
      }),
    ).toBe("phase.started:Provision sandbox");
    expect(
      recoveryEventKey({
        type: "job.claimed",
        data: { attempt: 2 },
      }),
    ).toBe("job.claimed:attempt-2");
    expect(
      recoveryEventKey({
        type: "job.enqueued",
        data: { dispatchGeneration: 1 },
      }),
    ).toBe("job.enqueued:generation-1");
  });

  it(
    "recovers a killed implementing worker from its checkpoint, then validates and completes",
    { timeout: 120_000 },
    async () => {
      const job = await createTestJob();
      await requestJobRun(job.id, job.dispatchGeneration, testQueue.queue);

      const workerA = startChild("crash-worker-a", "interrupt");
      const checkpoint = await waitFor(
        async () => {
          const latest = await getLatestCheckpoint(job.id);
          return latest?.kind === "agent_turn" ? latest : null;
        },
        { timeoutMs: 60_000, label: "worker A's implementation checkpoint" },
      );
      const before = await readJob(job.id);
      expect(before.status).toBe("implementing");
      expect(before.leaseOwner).toBe("crash-worker-a");

      // No SIGTERM, no drain, no lease release. The whole point of the lease is
      // that the replacement worker needs nothing from this process, including
      // the courtesy of being told.
      const signal = await kill(workerA);
      expect(signal).toBe("SIGKILL");

      startChild("crash-worker-b", "finish");
      const finished = await waitForStatus(job.id, "completed", { timeoutMs: 60_000 });

      expect(finished.attemptCount).toBe(2);
      expect(finished.leaseOwner).toBeNull();
      // The dead worker's message is still `active` in Redis. Worker B does not
      // wait for BullMQ to declare it stalled: the reclaim moved the row to
      // `queued` on a new generation and delivered that instead.
      expect(finished.dispatchGeneration).toBeGreaterThan(before.dispatchGeneration);

      const events = await readEvents(job.id);
      const keys = events.map((event) => recoveryEventKey(event));
      expect(keys).toContain("job.claimed:attempt-1");
      expect(keys).toContain("job.reclaimed");
      expect(keys).toContain(`job.enqueued:generation-${finished.dispatchGeneration}`);
      expect(keys).toContain("job.claimed:attempt-2");
      expect(keys).toContain("run.resumed");

      // Acknowledged work is not repeated: the baseline still means "before
      // anything was edited", and the plan is not paid for twice.
      expect(keys.filter((key) => key === "phase.started:Establish test baseline")).toHaveLength(1);
      expect(keys.filter((key) => key === "phase.started:Create plan")).toHaveLength(1);

      const resumed = events.find((event) => event.type === "run.resumed");
      expect(resumed?.data).toMatchObject({
        checkpointId: checkpoint.id,
        checkpointKind: "agent_turn",
        resumePhase: "implementing",
        attempt: 2,
      });
    },
  );
});

/**
 * A worker in its own process.
 *
 * `detached` so the kill reaches the whole group: `tsx` runs under a shell
 * wrapper, and killing only the wrapper would leave a perfectly healthy worker
 * holding the job the test is about to claim was abandoned.
 */
function startChild(workerId: string, mode: "interrupt" | "finish"): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CHILD, testQueue.queue.bull.name, workerId, mode],
    {
      cwd: resolve(import.meta.dirname, "../.."),
      detached: process.platform !== "win32",
      env: { ...process.env, RIVET_TEST_LOG_LEVEL: process.env.RIVET_TEST_LOG_LEVEL ?? "silent" },
      // stdout is piped so a silent child adds nothing to the suite's output;
      // stderr is inherited so a child that dies says why.
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  children.push(child);
  return child;
}

async function kill(child: ChildProcess): Promise<string | null> {
  const exited = new Promise<string | null>((resolveExit) => {
    child.once("exit", (_code, signal) => resolveExit(signal));
  });
  if (child.pid === undefined) throw new Error("The child worker never started.");
  process.kill(-child.pid, "SIGKILL");
  return exited;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  process.kill(-child.pid, "SIGKILL");
  await exited;
}
