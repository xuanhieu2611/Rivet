import { PiCodingAgent } from "@rivet/agent";
import {
  type AgentOptions,
  buildPipeline,
  instrumentGitHubOptions,
  type Phase,
  type SandboxProvider,
  simulatedPipeline,
} from "@rivet/core";
import { closeDb } from "@rivet/database";
import {
  closeJobQueue,
  closeRedis,
  getBullJobQueue,
  type JobRunsMessage,
  QUEUE_NAMES,
  getRedis,
} from "@rivet/queue";
import { dockerConnectionTarget, DockerSandboxProvider } from "@rivet/sandbox";
import type { TelemetryHandle } from "@rivet/telemetry";
import { Worker } from "bullmq";

import { findRepositoryRoot, loadRootEnv, parseWorkerConfig, WorkerConfigError } from "./config";
import { createLocalSeedOptions } from "./eval";
import { createFaultInjection, type FaultInjection } from "./faults";
import { createGitHubOptions } from "./github";
import { reapHostGitTemporaryFiles } from "./git/host-git";
import { createWorkerId } from "./identity";
import { createLogger } from "./logger";
import { createProcessor, RunRegistry } from "./processor";
import { loadScriptedAgent } from "./scripted-agent";
import { SecretRegistry } from "./secrets";
import { createSweepRunner } from "./sweeper";
import { createWorkerTelemetry } from "./telemetry";

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
// Constructed before the logger, because the logger's redaction pass reads from
// it on every line and a token must never exist before the pass knows about it.
const secrets = new SecretRegistry();
/**
 * Filled in a few lines below, and read by every log line until it is.
 *
 * The ordering is genuinely circular: the logger's mixin wants the active
 * span's trace context, and `createWorkerTelemetry` wants a logger to report
 * export failures to. A `let` the mixin closes over is the honest way to break
 * it - lines written before the handle exists simply carry no trace ids, which
 * is exactly what they should carry, because no span was open yet.
 */
const telemetryRef: { current: TelemetryHandle | undefined } = { current: undefined };
const log = createLogger(config.logLevel, workerId, secrets, () =>
  telemetryRef.current?.telemetry.traceContext(),
);
const runs = new RunRegistry();

/**
 * Traces and metrics, or the absence of them.
 *
 * The fifth member of the switch family and the only one whose `off` is legal
 * in production, because it is the only one that does not make the worker lie
 * about its work: every phase still runs, and all that is missing is the
 * ability to watch. So this warns where the others refuse - loudly under
 * production, where a system nobody can see is a real problem, and once
 * anywhere else, where it is the default.
 */
telemetryRef.current = createWorkerTelemetry(config.telemetry, workerId, log);
const telemetry = telemetryRef.current;
if (!telemetry) {
  const message =
    "RIVET_TELEMETRY=off: this worker exports no traces and no metrics, so a run can only be " +
    "reconstructed from its event log";
  if (process.env.NODE_ENV === "production") log.warn(message);
  else log.info(message);
}

/**
 * Publication, or the absence of it.
 *
 * Built once here so `packages/core` never learns that Octokit exists, and so
 * the App credentials stay in the worker process. Under `RIVET_GITHUB=off` this
 * is undefined, `PipelineOptions.github` is absent, provisioning keeps the
 * unauthenticated in-container clone and `finalizing` records
 * `publication.skipped` - which is what CI and every existing suite run under,
 * and what `parseWorkerConfig` refuses in production.
 */
const github = (() => {
  const options = createGitHubOptions(config.github, secrets);
  // Wrapped here rather than inside the adapter, so `apps/worker/src/github.ts`
  // stays the file whose only job is keeping credentials out of core. Under
  // `RIVET_TELEMETRY=off` there is nothing to wrap with and the options pass
  // through untouched.
  return options && telemetry ? instrumentGitHubOptions(options, telemetry.telemetry) : options;
})();
if (!github) {
  log.warn("RIVET_GITHUB=off: no pull request will be opened, jobs end at the validated diff");
}

/**
 * The evaluation harness's seed source, or the absence of it.
 *
 * Under `RIVET_EVAL=off` - which is the default, what CI runs, and what
 * `parseWorkerConfig` requires in production - this is undefined and a job that
 * names a `rivet-local:` repository fails saying so. Nothing else changes:
 * there is no phase, no status and no event behind this switch, because an
 * evaluation job has to be an ordinary job or the harness is measuring
 * something nobody deploys.
 */
const localSeed = createLocalSeedOptions(config.eval, { repositoryRoot: findRepositoryRoot() });
if (localSeed) {
  log.warn(
    { fixtureRoot: config.eval.fixtureRoot },
    "RIVET_EVAL=on: this worker will seed jobs from local benchmark fixtures",
  );
}

if (config.replay.mode === "on") {
  log.warn("RIVET_REPLAY=on: this process is allowed to manufacture a job timeline from a fixture");
}

/**
 * The pipeline this worker runs, and the provider behind it.
 *
 * The choice is made once, here, and everything downstream is told rather than
 * asked: `buildPipeline` closes the provider and the limits into the phase
 * bodies, so nothing in `packages/core` ever reads an environment variable and
 * the processor never learns that Docker exists. `RIVET_SANDBOX=off` returns
 * the Milestone 1 pipeline unchanged - seven sleeps and no daemon - which is
 * what the integration suite runs under and what `parseWorkerConfig` refuses in
 * production.
 *
 * Constructing the provider connects to nothing; dockerode dials per request.
 * A missing daemon therefore surfaces as the first job's `sandbox_unavailable`
 * rather than as a worker that will not start, which is the right way round: a
 * worker that can still sweep, reclaim and report is more useful than one that
 * refused to boot.
 */
/**
 * The coding agent, or nothing at all.
 *
 * Constructing this loads no SDK and opens no connection - the harness is
 * imported on the first session - so a worker with a bad model id still starts,
 * still sweeps, still reclaims, and fails the first job with a reason rather
 * than refusing to boot with a stack trace. The one thing that *is* checked at
 * startup is the key, in `parseWorkerConfig`, because that failure is otherwise
 * discovered after a container and a clone have already been paid for.
 *
 * Under `RIVET_AGENT=off` this is undefined, `PipelineOptions.agent` is absent,
 * and `implementing` keeps the Milestone 1 sleep. That is what lets the
 * integration suite run thirty-odd lifecycle cases with no key.
 */
const agent: AgentOptions | undefined = await (async () => {
  if (config.agent.mode === "off") {
    log.warn("RIVET_AGENT=off: the implementing phase is simulated, no model will be called");
    return undefined;
  }

  // The one place a scripted session is allowed to enter the production
  // wiring, and it is loaded rather than constructed here so nothing about a
  // demo fixture is compiled into the worker. `parseWorkerConfig` has already
  // refused this mode under `NODE_ENV=production`.
  const coding =
    config.agent.mode === "scripted"
      ? await loadScriptedAgent(config.agent.scriptPath ?? "").catch((error: unknown) => {
          // A missing or malformed script is a configuration error, so it gets
          // the configuration error's treatment: refuse to boot, say why once,
          // and do not start taking jobs a canned session cannot run.
          log.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        })
      : new PiCodingAgent({
          model: config.agent.model,
          provider: config.agent.provider,
          homeDir: config.agent.homeDir,
          outputMaxBytes: config.agent.toolOutputMaxBytes,
          logger: log,
        });

  if (config.agent.mode === "scripted") {
    log.warn(
      { script: config.agent.scriptPath },
      "RIVET_AGENT=scripted: sessions replay a canned script, no model will be called",
    );
  }

  return {
    coding,
    sessionTimeoutMs: config.agent.sessionTimeoutMs,
    maxTurns: config.agent.maxTurns,
    previewMaxBytes: config.agent.previewMaxBytes,
    fileMaxBytes: config.agent.fileMaxBytes,
  };
})();

const { phases, phaseFactory, sandbox, assertNetworkIsolation } = ((): {
  phases: readonly Phase[];
  phaseFactory?: (injection: FaultInjection) => readonly Phase[];
  sandbox?: SandboxProvider;
  assertNetworkIsolation?: () => Promise<void>;
} => {
  if (config.sandbox.mode === "off") {
    log.warn("RIVET_SANDBOX=off: running the simulated pipeline, no containers will be created");
    return { phases: simulatedPipeline() };
  }

  const target = dockerConnectionTarget();
  log.info({ socketPath: target.socketPath, source: target.source }, "using the Docker daemon");

  const provider = new DockerSandboxProvider({
    workerId,
    log,
    reapGraceMs: config.sandbox.reapGraceMs,
    ...(telemetry ? { telemetry: telemetry.telemetry } : {}),
  });
  const pipelineOptions = {
    ...(agent ? { agent } : {}),
    ...(telemetry ? { telemetry: telemetry.telemetry } : {}),
    ...(github ? { github } : {}),
    ...(localSeed ? { localSeed } : {}),
    ...(config.github.appBaseUrl ? { appBaseUrl: config.github.appBaseUrl } : {}),
    image: config.sandbox.image,
    workdir: config.sandbox.workdir,
    memoryBytes: config.sandbox.memoryBytes,
    nanoCpus: config.sandbox.nanoCpus,
    pidsLimit: config.sandbox.pidsLimit,
    commandTimeoutMs: config.sandbox.commandTimeoutMs,
    cloneTimeoutMs: config.sandbox.cloneTimeoutMs,
    installTimeoutMs: config.sandbox.installTimeoutMs,
    baselineTimeoutMs: config.sandbox.baselineTimeoutMs,
    checkTimeoutMs: config.sandbox.checkTimeoutMs,
    diffMaxBytes: config.sandbox.diffMaxBytes,
    validationReportMaxBytes: config.sandbox.validationReportMaxBytes,
    targetedMaxFiles: config.sandbox.targetedMaxFiles,
  };

  return {
    phases: buildPipeline({ sandbox: provider, ...pipelineOptions }),
    phaseFactory: (injection) =>
      buildPipeline({ sandbox: injection.sandbox ?? provider, ...pipelineOptions }),
    sandbox: provider,
    assertNetworkIsolation: () =>
      provider.assertNetworkIsolation({
        image: config.sandbox.image,
        databaseUrl: process.env.DATABASE_URL ?? "",
        redisUrl: process.env.REDIS_URL ?? "",
      }),
  };
})();

if (assertNetworkIsolation) {
  try {
    await assertNetworkIsolation();
    log.info("sandbox network isolation probe passed");
  } catch (error) {
    log.error({ err: error }, "sandbox network isolation probe failed; refusing to start");
    process.exit(1);
  }
}

// The worker needs a `Queue` as well as a `Worker`: the sweeper re-enqueues
// what it reclaims, and the recurring sweep itself is registered through the
// queue's scheduler.
const queue = getBullJobQueue();
const sweep = createSweepRunner({
  queue,
  config,
  log,
  ...(telemetry ? { telemetry: telemetry.telemetry } : {}),
  // The reaper's half of the sweep. Absent under `off`, where there is nothing
  // to reap and no daemon to ask.
  ...(sandbox ? { sandbox } : {}),
  cleanupOrphans: async () => {
    const [temporaryFiles, schedulers] = await Promise.all([
      reapHostGitTemporaryFiles({ olderThanMs: config.sandbox.reapGraceMs }),
      queue.removeStaleSchedulers(),
    ]);
    return { temporaryFiles: temporaryFiles.length, schedulers: schedulers.length };
  },
});

// Redis schedulers cover steady state, but a worker must also reconcile once
// before it settles into waiting. This closes the restart window where a job
// was reclaimed or its enqueue was lost while every scheduler message was
// absent. The pass is deliberately best effort: a worker that cannot reach the
// database can still start and let the next scheduler or worker retry it.
void sweep().then(
  () => log.info("startup reconciliation complete"),
  (error: unknown) => log.error({ err: error }, "startup reconciliation failed"),
);

const worker = new Worker<JobRunsMessage>(
  QUEUE_NAMES.jobRuns,
  createProcessor({
    config,
    workerId,
    log,
    runs,
    sweep,
    phases,
    ...(telemetry ? { telemetry: telemetry.telemetry } : {}),
    redactor: secrets,
    ...(phaseFactory ? { phaseFactory } : {}),
    // One injection per run, because `hang` is per-run state. Without
    // `RIVET_FAULT_*` set this is the plain abortable sleep and no fault at all.
    faults: () => createFaultInjection(config.fault, log, sandbox),
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
    sandbox: config.sandbox.mode,
    sandboxImage: config.sandbox.mode === "docker" ? config.sandbox.image : null,
    agent: config.agent.mode,
    model: agent ? `${config.agent.provider}/${config.agent.model}` : null,
    github: config.github.mode,
    telemetry: config.telemetry.mode,
    otlpEndpoint: telemetry ? config.telemetry.endpoint : null,
    // The App id identifies the App, not the credential, so it is safe to
    // print - and it is the first thing anyone checks when an installation
    // cannot see a repository.
    githubAppId: github ? (config.github.appId ?? null) : null,
    appBaseUrl: config.github.appBaseUrl ?? null,
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
    // Last, and after the runs have wound up, so the spans they ended on the
    // way out are in the final batch. It never rejects: a collector that is
    // down must not turn a graceful shutdown into a failed one.
    await telemetry?.shutdown();
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
