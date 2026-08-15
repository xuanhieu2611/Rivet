import { randomUUID } from "node:crypto";

import type { JobEvent, JobEventType, JobStatus } from "@rivet/contracts";
import { createJob, type JobQueue, listEvents } from "@rivet/core";
import { closeDb, db, type Job, jobs, type NewJob } from "@rivet/database";
import {
  BullJobQueue,
  closeRedis,
  createJobRunQueue,
  getRedis,
  type JobRunsMessage,
  QUEUE_NAMES,
} from "@rivet/queue";
import { type JobsOptions, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { pino } from "pino";

import type { WorkerConfig } from "../../src/config";
import type { FaultInjection } from "../../src/faults";
import { createProcessor, RunRegistry } from "../../src/processor";
import { createSweepRunner } from "../../src/sweeper";

/**
 * The scaffolding every integration test file shares.
 *
 * Three things in here are load-bearing rather than convenience:
 *
 * - **Every file gets its own queue name.** Two suites sharing `job-runs` would
 *   deliver each other's messages, and the failure would look like a flake
 *   rather than a collision. `uniqueQueueName` makes that impossible, and
 *   `obliterate` on teardown keeps Redis from filling up with dead keyspaces.
 * - **Time is compressed, not faked.** A two-second lease and a half-second
 *   heartbeat are real timings against a real database, so the lease protocol
 *   is genuinely exercised; `pipelineSpeed: 0` is what stops that costing 21
 *   seconds a job. No fake timers: they cannot survive a round trip to
 *   Postgres, which is where the clock that matters actually lives.
 * - **The processor under test is the production one.** These tests import
 *   `createProcessor` from `src/`, not a copy. What is injected is only what
 *   the real worker also injects: config, phases, faults.
 */

/** Silent by default; flip to `debug` when a test is being mysterious. */
export const testLogger = pino({ level: process.env.RIVET_TEST_LOG_LEVEL ?? "silent" });

/**
 * Deliberately faster than any production configuration.
 *
 * `heartbeatSeconds` is fractional, which `parseWorkerConfig` would reject -
 * the `heartbeat * 3 <= lease` invariant is about seconds-scale values. Tests
 * build the config object directly, which is exactly why that invariant is
 * asserted at parse time rather than being trusted.
 */
export const TEST_CONFIG: WorkerConfig = {
  concurrency: 2,
  leaseSeconds: 2,
  heartbeatSeconds: 0.5,
  sweepIntervalMs: 1_000,
  maxAttempts: 3,
  pipelineSpeed: 0,
  artifactMaxBytes: 262_144,
  checkpointMaxBytes: 4 * 1_024 * 1_024,
  checkpointTimeoutMs: 30_000,
  shutdownGraceMs: 5_000,
  logLevel: "fatal",
  // `off`, and the whole suite depends on it: these integration tests are about the
  // lease, the queue and the recovery paths, and they run in CI against
  // Postgres and Redis service containers with no Docker daemon anywhere. A
  // test that wants a real sandbox belongs in the `*.sbx.test.ts` suite.
  sandbox: {
    mode: "off",
    image: "unused-under-off",
    workdir: "/home/node/workspace",
    memoryBytes: 512 * 1_024 * 1_024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 128,
    commandTimeoutMs: 5_000,
    cloneTimeoutMs: 5_000,
    installTimeoutMs: 5_000,
    baselineTimeoutMs: 5_000,
    checkTimeoutMs: 5_000,
    maxOutputBytes: 16_384,
    diffMaxBytes: 262_144,
    validationReportMaxBytes: 1_048_576,
    targetedMaxFiles: 25,
    reapGraceMs: 120_000,
  },
  // `off` for the same reason the sandbox is: this suite is about the lease,
  // the queue and the recovery paths, and it runs in CI with no model key. A
  // test that wants a session drives `FakeCodingAgent` through the pipeline it
  // builds, rather than through this configuration.
  agent: {
    mode: "off",
    model: "unused-under-off",
    provider: "unused-under-off",
    sessionTimeoutMs: 5_000,
    maxTurns: 4,
    toolOutputMaxBytes: 4_096,
    fileMaxBytes: 16_384,
    previewMaxBytes: 512,
    homeDir: "/tmp/rivet-pi-test",
  },
};

export function uniqueQueueName(suite: string): string {
  return `${QUEUE_NAMES.jobRuns}-test-${suite}-${randomUUID().slice(0, 8)}`;
}

/** Truncates both tables. Called between tests, never against a remote database. */
export async function resetDatabase(): Promise<void> {
  await db.execute(sql`truncate table job_events, jobs restart identity cascade`);
}

/** Closes the pooled connections this test process opened. */
export async function closeConnections(): Promise<void> {
  await closeRedis();
  await closeDb();
}

export interface TestQueue {
  queue: BullJobQueue;
  /** Removes the queue's entire keyspace, including any scheduler it registered. */
  destroy: () => Promise<void>;
}

/**
 * A queue on a throwaway name.
 *
 * `jobOptions` exists for the retry test: the production backoff starts at five
 * seconds, which is a fine default and an unbearable test.
 */
export function createTestQueue(suite: string, jobOptions: JobsOptions = {}): TestQueue {
  const queue = new BullJobQueue(createJobRunQueue(uniqueQueueName(suite), jobOptions));

  return {
    queue,
    destroy: async () => {
      await queue.bull.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    },
  };
}

export interface TestWorkerOptions {
  queue: BullJobQueue;
  workerId?: string;
  config?: Partial<WorkerConfig>;
  phases?: Parameters<typeof createProcessor>[0]["phases"];
  phaseFactory?: Parameters<typeof createProcessor>[0]["phaseFactory"];
  faults?: () => FaultInjection;
  /** Wires the real sweep runner into this worker's `sweep` messages. */
  withSweeper?: boolean;
}

export interface TestWorker {
  worker: Worker<JobRunsMessage>;
  workerId: string;
  close: () => Promise<void>;
}

/**
 * A real BullMQ worker running the real processor.
 *
 * `concurrency` and `drainDelay` are the only settings that differ from
 * production, and both are about latency: a test that waits thirty seconds for
 * a blocking pop to notice a message is not a test anyone runs twice.
 */
export function startTestWorker(options: TestWorkerOptions): TestWorker {
  const config: WorkerConfig = { ...TEST_CONFIG, ...options.config };
  const workerId = options.workerId ?? `test-worker-${randomUUID().slice(0, 8)}`;
  const log = testLogger.child({ workerId });
  const sweep = options.withSweeper
    ? createSweepRunner({ queue: options.queue, config, log })
    : undefined;

  const worker = new Worker<JobRunsMessage>(
    options.queue.bull.name,
    createProcessor({
      config,
      workerId,
      log,
      runs: new RunRegistry(),
      ...(options.phases ? { phases: options.phases } : {}),
      ...(options.phaseFactory ? { phaseFactory: options.phaseFactory } : {}),
      ...(options.faults ? { faults: options.faults } : {}),
      ...(sweep ? { sweep } : {}),
    }),
    {
      // The same shared client the real worker uses, which is also the only
      // one configured the way BullMQ demands (`maxRetriesPerRequest: null`).
      connection: getRedis(),
      concurrency: config.concurrency,
      drainDelay: 1,
      lockDuration: 30_000,
      stalledInterval: 5_000,
    },
  );

  // Match the production worker's startup reconciliation. Tests that opt into
  // the sweeper should not need to manufacture a scheduler tick just to prove
  // a queued row can recover after a restart.
  void sweep?.().catch((error: unknown) => {
    testLogger.warn({ err: error }, "test startup reconciliation failed");
  });

  return {
    worker,
    workerId,
    close: async () => {
      await worker.close(true);
    },
  };
}

/**
 * Puts a job row into a state some earlier attempt would have left it in.
 *
 * Deliberately not a status write - it cannot be, since `status` is excluded
 * from the patch type - and deliberately not a way around `transitionJob`.
 * Cumulative counters and the job deadline become true through a claim and a
 * session, and a test about what happens *after* those is entitled to arrange
 * them directly rather than running a whole first attempt to earn them.
 */
export async function patchTestJob(
  jobId: string,
  patch: Omit<Partial<NewJob>, "status">,
): Promise<void> {
  await db.update(jobs).set(patch).where(eq(jobs.id, jobId));
}

/** Creates a job row through the real service, with sensible test defaults. */
export async function createTestJob(
  overrides: Partial<{
    title: string;
    maxDurationSeconds: number;
    maxCostUsd: string;
    maxModelCalls: number;
    maxToolCalls: number;
  }> = {},
) {
  const job = await createJob({
    title: overrides.title ?? "Integration test job",
    description: "Created by the integration suite.",
    repoUrl: "https://github.com/rivet/example",
    baseBranch: "main",
    reviewMode: "independent",
    maxReviewLoops: 2,
  });

  const patch = {
    ...(overrides.maxDurationSeconds === undefined
      ? {}
      : { maxDurationSeconds: overrides.maxDurationSeconds }),
    ...(overrides.maxCostUsd === undefined ? {} : { maxCostUsd: overrides.maxCostUsd }),
    ...(overrides.maxModelCalls === undefined ? {} : { maxModelCalls: overrides.maxModelCalls }),
    ...(overrides.maxToolCalls === undefined ? {} : { maxToolCalls: overrides.maxToolCalls }),
  };
  if (Object.keys(patch).length > 0) {
    // Not a status write, so it does not need `transitionJob`. `createJob` takes
    // only the user-supplied fields, and these limits are columns with defaults.
    await db.update(jobs).set(patch).where(eq(jobs.id, job.id));
  }

  return job;
}

/** The raw row, for assertions about columns the contract does not expose. */
export async function readJob(jobId: string): Promise<Job> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) throw new Error(`Job ${jobId} not found.`);
  return row;
}

export async function readEvents(jobId: string): Promise<JobEvent[]> {
  return listEvents(jobId, { limit: 500 });
}

export async function eventTypes(jobId: string): Promise<JobEventType[]> {
  return (await readEvents(jobId)).map((event) => event.type);
}

/**
 * The north-star trace and its assertions live in `src/recovery-trace.ts`.
 *
 * Re-exported here so every test keeps importing its scaffolding from one
 * place, and so `pnpm demo:recovery` - which is not a test and cannot import
 * this file - checks the same trace against a real Docker run.
 */
export {
  assertMilestone6RecoveryEventSequence,
  assertMilestone6RecoveryFacts,
  MILESTONE_6_RECOVERY_EVENT_SEQUENCE,
  type Milestone6RecoveryFacts,
  recoveryEventKey,
} from "../../src/recovery-trace";

/** Enqueues without the event bookkeeping, when a test only needs the message. */
export async function enqueue(
  queue: JobQueue,
  jobId: string,
  dispatchGeneration = 0,
): Promise<void> {
  await queue.enqueueJobRun(jobId, dispatchGeneration);
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

/**
 * Polls until `check` returns something truthy, or gives up loudly.
 *
 * Polling rather than event subscriptions because the thing being waited on is
 * a row in Postgres written by another process. There is no callback to wait
 * for; the database is the only witness.
 */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${options.label ?? "condition"}.`,
      );
    }
    await sleep(intervalMs);
  }
}

/** Waits for a job to reach any terminal-ish status the caller names. */
export async function waitForStatus(
  jobId: string,
  statuses: JobStatus | readonly JobStatus[],
  options: WaitOptions = {},
): Promise<Job> {
  const wanted = new Set(typeof statuses === "string" ? [statuses] : statuses);
  return waitFor(
    async () => {
      const row = await readJob(jobId);
      return wanted.has(row.status) ? row : null;
    },
    { label: `job ${jobId} to reach ${[...wanted].join(" or ")}`, ...options },
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
