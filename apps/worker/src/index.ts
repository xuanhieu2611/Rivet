import { closeDb } from "@rivet/database";
import {
  closeJobQueue,
  closeRedis,
  getBullJobQueue,
  type JobRunsMessage,
  QUEUE_NAMES,
  getRedis,
} from "@rivet/queue";
import { Worker } from "bullmq";

import { loadRootEnv, parseWorkerConfig, WorkerConfigError } from "./config";
import { createFaultInjection } from "./faults";
import { createWorkerId } from "./identity";
import { createLogger } from "./logger";
import { createProcessor, RunRegistry } from "./processor";
import { createSweepRunner } from "./sweeper";

/**
 * The worker entrypoint: config, wiring, and a shutdown that hands work back.
 *
 * There is no build step. `main` is `tsx src/index.ts`, the same raw-TypeScript
 * convention every workspace package follows, which also keeps `pnpm build` in
 * CI exactly as it was. Because this app has a `dev` script and turbo's `dev`
 * task is persistent, root `pnpm dev` now starts the web app and the worker
 * together - the whole local demo in one command.
 */

loadRootEnv();

const config = (() => {
  try {
    return parseWorkerConfig(process.env);
  } catch (error) {
    // Before the logger exists, so this is the one place `console` is right.
    // Exiting non-zero here is the entire point of validating at startup: a
    // worker with a heartbeat longer than its lease corrupts job state in a way
    // that is far harder to diagnose than a refusal to boot.
    console.error(error instanceof WorkerConfigError ? error.message : error);
    process.exit(1);
  }
})();

const workerId = createWorkerId();
const log = createLogger(config.logLevel, workerId);
const runs = new RunRegistry();

// The worker needs a `Queue` as well as a `Worker`: the sweeper re-enqueues
// what it reclaims, and the recurring sweep itself is registered through the
// queue's scheduler.
const queue = getBullJobQueue();
const sweep = createSweepRunner({ queue, config, log });

const worker = new Worker<JobRunsMessage>(
  QUEUE_NAMES.jobRuns,
  createProcessor({
    config,
    workerId,
    log,
    runs,
    sweep,
    // One injection per run, because `hang` is per-run state. Without
    // `RIVET_FAULT_*` set this is the plain abortable sleep and no fault at all.
    faults: () => createFaultInjection(config.fault, log),
  }),
  {
    connection: getRedis(),
    concurrency: config.concurrency,

    // Upstash bills per command and BullMQ polls Redis even when nothing is
    // happening. Each blocking pop waits this long before re-issuing, so raising
    // it from the 5s default costs essentially no latency - a job arriving wakes
    // the blocking call immediately - while cutting the idle command rate by six.
    drainDelay: 30,

    // BullMQ's own message-level lock. Deliberately longer than Rivet's lease:
    // Postgres is the authority on who owns a job, and having Redis reach its own
    // conclusion first would just add a second opinion nobody asked for.
    lockDuration: 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
);

worker.on("error", (error) => {
  // Transport-level trouble, not job trouble. BullMQ reconnects on its own.
  log.error({ err: error }, "worker error");
});

worker.on("failed", (job, error) => {
  log.warn({ jobId: job?.data.jobId, err: error }, "message failed");
});

/**
 * Registers the recurring sweep.
 *
 * Every worker upserts the same scheduler id, so the result is one sweep per
 * interval no matter how many workers are running - and the schedule lives in
 * Redis, so it survives every one of them restarting. A failure here is logged
 * rather than fatal: a worker that cannot register the schedule can still run
 * jobs perfectly well, and some other worker's schedule is very likely already
 * there.
 */
queue.scheduleSweeps(config.sweepIntervalMs).then(
  () => {
    log.info({ everyMs: config.sweepIntervalMs }, "sweep scheduled");
  },
  (error: unknown) => {
    log.error({ err: error }, "could not register the sweep scheduler");
  },
);

log.info(
  {
    concurrency: config.concurrency,
    leaseSeconds: config.leaseSeconds,
    heartbeatSeconds: config.heartbeatSeconds,
    sweepIntervalMs: config.sweepIntervalMs,
    maxAttempts: config.maxAttempts,
    pipelineSpeed: config.pipelineSpeed,
    fault: config.fault ?? null,
    queue: QUEUE_NAMES.jobRuns,
  },
  "worker started",
);

/**
 * Graceful shutdown.
 *
 * The order matters. Draining first aborts every in-flight run with
 * `WorkerShuttingDownError`, which the processor turns into a lease release and
 * a re-queue - so a deploy or a Ctrl-C hands work back immediately, rather than
 * failing jobs that were doing nothing wrong or making the next worker wait out
 * a 30-second lease expiry. Only then does `worker.close()` wait for those runs
 * to wind up, and only then are the connections closed under them.
 *
 * The hard deadline is not optional: a wedged job must not be able to block a
 * deploy forever.
 *
 * `kill -9` skips all of this, which is exactly the case the lease and the
 * sweeper exist for.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal, active: runs.size }, "shutting down");

  const deadline = setTimeout(() => {
    log.error("shutdown deadline exceeded; forcing exit");
    process.exit(1);
  }, config.shutdownGraceMs);

  try {
    runs.drain();
    await worker.close();
    // The schedule is deliberately left in place: it belongs to the queue, not
    // to this process, and the next worker to start would only have to upsert
    // it again.
    await closeJobQueue();
    await closeRedis();
    await closeDb();
    log.info("shutdown complete");
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, "shutdown failed");
    clearTimeout(deadline);
    process.exit(1);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
