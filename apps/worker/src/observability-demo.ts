/* eslint-disable no-console -- this command is a local end-to-end transcript */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import type { JobStatus } from "@rivet/contracts";
import { createJob, getJob, listEvents, requestJobRun } from "@rivet/core";
import { closeDb } from "@rivet/database";
import { closeJobQueue, closeRedis, getBullJobQueue, type BullJobQueue } from "@rivet/queue";

import { DEFAULT_MODEL, DEFAULT_MODEL_PROVIDER, loadRootEnv, parseWorkerConfig } from "./config";
import { assertLocalControlPlane } from "./demo-preflight";
import { selectDemoTask } from "./demo-tasks";

/**
 * Milestone 11's demo: one real job, and a link to its trace.
 *
 * The milestone's visible artifact is not a passing test, it is a populated
 * trace with a phase span per phase, a command span per command and a model
 * span per turn - so this command's job is to run something real and then hand
 * over the URL that shows it.
 *
 * Everything expensive is checked before anything is spent. A real job costs a
 * container, a clone and a model session, and printing a dead Grafana link
 * after all of that is the failure this command exists to avoid: the run would
 * look successful and the deliverable would be missing. So the collector,
 * Tempo and Grafana are all probed up front, and the command refuses early and
 * says which one is not answering.
 */

const FIXTURE_REPOSITORY = "https://github.com/xuanhieu2611/rivet-fixture-node";
const FIXTURE_BRANCH = "main";
const GRAFANA_URL = process.env.RIVET_GRAFANA_URL ?? "http://localhost:3001";
const TEMPO_URL = process.env.RIVET_TEMPO_URL ?? "http://localhost:3200";
const TEMPO_DATASOURCE_UID = "tempo";

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exceeded",
]);

async function main(): Promise<void> {
  loadRootEnv();
  const workerConfig = parseWorkerConfig(process.env);
  assertDemoConfiguration();
  await assertStackIsUp(workerConfig.telemetry.endpoint);

  const root = resolve(import.meta.dirname, "../../..");
  const worker = startWorker(root);
  let queue: BullJobQueue | undefined;
  let jobId: string | undefined;
  let ran = false;

  try {
    queue = getBullJobQueue();
    const task = selectDemoTask(process.env.RIVET_DEMO_TASK);
    const job = await createJob({
      title: task.title,
      description: task.description,
      repoUrl: FIXTURE_REPOSITORY,
      baseBranch: FIXTURE_BRANCH,
      reviewMode: workerConfig.reviewMode,
      maxReviewLoops: workerConfig.maxReviewLoops,
    });
    jobId = job.id;

    const enqueued = await requestJobRun(job.id, job.dispatchGeneration, queue);
    if (enqueued.result === null) {
      throw new Error("The job was created, but Redis did not accept its queue message.");
    }

    console.log(`Created job ${job.id} for task ${task.id}`);
    console.log(`Watching ${FIXTURE_REPOSITORY} on ${FIXTURE_BRANCH} ...`);
    await watchJob(job.id, worker);
    ran = true;

    const finished = await getJob(job.id);
    if (!finished) throw new Error(`Job ${job.id} disappeared before the demo finished.`);
    if (finished.status !== "completed") {
      throw new Error(
        `Demo job ended ${finished.status}: ${finished.failureReason ?? "no failure reason"}`,
      );
    }
  } finally {
    // Stopped before Tempo is queried, and that ordering is the point:
    // `TelemetryHandle.shutdown()` forces a final export, so waiting for the
    // 15-second metric interval to come around is not part of the demo.
    await stopWorker(worker);
    // Only when a job actually reached a terminal status. A worker that
    // refused to boot has no trace to wait for, and a minute of "waiting for
    // Tempo" would bury the reason it refused.
    if (jobId && ran) await report(jobId);
    await closeJobQueue();
    await closeRedis();
    await closeDb();
  }
}

function assertDemoConfiguration(): void {
  assertLocalControlPlane("pnpm demo:observability");

  if (process.env.RIVET_SANDBOX === "off") {
    throw new Error(
      "pnpm demo:observability needs RIVET_SANDBOX=docker so real phases produce real spans.",
    );
  }
  if (process.env.RIVET_AGENT !== "pi") {
    throw new Error(
      "pnpm demo:observability needs RIVET_AGENT=pi. The model session, its turns and its tool " +
        "calls are most of what the trace is worth looking at.",
    );
  }
  if (process.env.RIVET_TELEMETRY !== "otlp") {
    throw new Error(
      "pnpm demo:observability needs RIVET_TELEMETRY=otlp. With telemetry off the job runs " +
        "perfectly well and exports nothing, which is exactly the run this command must not " +
        "report as a success.",
    );
  }

  const provider = process.env.RIVET_MODEL_PROVIDER ?? DEFAULT_MODEL_PROVIDER;
  if (provider === DEFAULT_MODEL_PROVIDER && !process.env.OPENROUTER_API_KEY) {
    throw new Error(
      `OPENROUTER_API_KEY is required for pnpm demo:observability with ${DEFAULT_MODEL}. ` +
        "Put it in .env.local or export it first.",
    );
  }
}

/** Three probes, named individually, before a single container is created. */
async function assertStackIsUp(otlpEndpoint: string): Promise<void> {
  const checks: { name: string; url: string; hint: string }[] = [
    {
      name: "OTLP collector",
      // A POST with no body: the collector answers 400, which is all this
      // needs. A refused connection is a different thing entirely and is what
      // the check is actually looking for.
      url: `${otlpEndpoint}/v1/traces`,
      hint: "start it with pnpm obs:up",
    },
    { name: "Tempo", url: `${TEMPO_URL}/api/echo`, hint: "start it with pnpm obs:up" },
    { name: "Grafana", url: `${GRAFANA_URL}/api/health`, hint: "start it with pnpm obs:up" },
  ];

  for (const check of checks) {
    try {
      await fetch(check.url, { signal: AbortSignal.timeout(3_000) });
    } catch {
      throw new Error(`${check.name} is not answering at ${check.url} - ${check.hint}.`);
    }
  }
  console.log(`Observability stack is up: collector, Tempo and Grafana all answered.`);
}

function startWorker(root: string): ChildProcess {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["--filter", "@rivet/worker", "start"], {
    cwd: root,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      RIVET_SANDBOX: process.env.RIVET_SANDBOX ?? "docker",
      RIVET_AGENT: "pi",
      RIVET_TELEMETRY: "otlp",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  child.once("error", (error) => {
    console.error(`[demo worker] ${error.message}`);
  });
  return child;
}

async function watchJob(jobId: string, worker: ChildProcess): Promise<void> {
  let cursor = 0;

  for (;;) {
    const events = await listEvents(jobId, { after: cursor, limit: 200 });
    for (const event of events) {
      cursor = event.id;
      console.log(`[${event.type}] ${event.message}`);
    }

    const job = await getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} disappeared while it was running.`);
    if (TERMINAL_STATUSES.has(job.status)) {
      console.log(`Final status: ${job.status}`);
      return;
    }
    if (worker.exitCode !== null) {
      throw new Error(
        `The demo worker exited before job ${jobId} reached a terminal status ` +
          `(code ${worker.exitCode ?? "none"}, signal ${worker.signalCode ?? "none"}).`,
      );
    }

    await sleep(500);
  }
}

/** The deliverable: a resolved trace id, and the URL that opens it. */
async function report(jobId: string): Promise<void> {
  const query = `{ .rivet.job_id = "${jobId}" }`;
  const traceId = await findTrace(query);

  console.log("");
  if (!traceId) {
    // Not thrown. The job really did run, and telling somebody their trace has
    // not landed yet is more useful than failing the command out from under a
    // completed job.
    console.log(`No trace for job ${jobId} in Tempo yet. Search there directly:`);
    console.log(`  ${exploreUrl(query)}`);
    return;
  }

  console.log(`Trace for job ${jobId}:`);
  console.log(`  ${exploreUrl(traceId)}`);
  console.log(`  ${TEMPO_URL}/api/traces/${traceId}`);
  console.log("");
  console.log(`Every span in this job, across attempts:`);
  console.log(`  ${exploreUrl(query)}`);
}

/**
 * Polls Tempo for the job's trace.
 *
 * Ingestion is not instant even after a forced flush, so this waits rather than
 * asking once and reporting a miss - a demo whose link is empty half the time
 * is a demo nobody trusts the other half.
 */
async function findTrace(query: string): Promise<string | undefined> {
  const deadline = Date.now() + 60_000;
  const url = `${TEMPO_URL}/api/search?q=${encodeURIComponent(query)}&limit=1`;

  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const body = (await response.json()) as { traces?: { traceID?: string }[] };
        const traceId = body.traces?.[0]?.traceID;
        if (traceId) return traceId;
      }
    } catch {
      // Tempo restarting mid-poll is not worth ending the demo over.
    }

    if (Date.now() >= deadline) return undefined;
    console.log("Waiting for Tempo to ingest the trace ...");
    await sleep(3_000);
  }
}

/** A Grafana Explore link, in the `panes` shape Grafana 11 reads. */
function exploreUrl(query: string): string {
  const panes = {
    rivet: {
      datasource: TEMPO_DATASOURCE_UID,
      queries: [
        {
          refId: "A",
          datasource: { type: "tempo", uid: TEMPO_DATASOURCE_UID },
          queryType: "traceql",
          query,
        },
      ],
      range: { from: "now-1h", to: "now" },
    },
  };
  return (
    `${GRAFANA_URL}/explore?orgId=1&schemaVersion=1&panes=` +
    encodeURIComponent(JSON.stringify(panes))
  );
}

async function stopWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null) return;

  await new Promise<void>((resolveWorker) => {
    const timer = setTimeout(() => {
      if (process.platform === "win32" || worker.pid === undefined) {
        worker.kill("SIGKILL");
      } else {
        process.kill(-worker.pid, "SIGKILL");
      }
      resolveWorker();
    }, 15_000);
    timer.unref();

    worker.once("exit", () => {
      clearTimeout(timer);
      resolveWorker();
    });

    if (process.platform === "win32" || worker.pid === undefined) {
      worker.kill("SIGINT");
    } else {
      process.kill(-worker.pid, "SIGINT");
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
