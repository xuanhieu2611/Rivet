/* eslint-disable no-console -- this command is a local end-to-end transcript */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import type { JobStatus } from "@rivet/contracts";
import {
  createJob,
  getArtifact,
  getJob,
  listArtifacts,
  listEvents,
  requestJobRun,
} from "@rivet/core";
import { closeDb } from "@rivet/database";
import { closeJobQueue, closeRedis, getBullJobQueue, type BullJobQueue } from "@rivet/queue";

import { DEFAULT_MODEL_PROVIDER, DEFAULT_MODEL, loadRootEnv } from "./config";

const FIXTURE_REPOSITORY = "https://github.com/xuanhieu2611/rivet-fixture-node";
const FIXTURE_BRANCH = "main";
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exceeded",
]);

/**
 * Runs the Milestone 5 definition-of-done locally.
 *
 * The worker is started as a child rather than imported here. `src/index.ts`
 * owns the production wiring and has intentional module-level startup effects;
 * this command should exercise that wiring, not copy it into a second worker.
 * The child and this process share Postgres and Redis, just like the web app and
 * a separately deployed worker do.
 */
async function main(): Promise<void> {
  loadRootEnv();
  assertDemoConfiguration();

  const root = resolve(import.meta.dirname, "../../..");
  const worker = startWorker(root);
  let queue: BullJobQueue | undefined;

  try {
    queue = getBullJobQueue();
    const job = await createJob({
      title: "Fix the bulk discount boundary",
      description:
        "The fixture says that 10 items or more qualify for the bulk discount, but the " +
        "implementation uses a strict greater-than comparison. Fix the bug without weakening " +
        "the tests, then run the repository test suite before you finish and summarize the " +
        "change in your final message.",
      repoUrl: FIXTURE_REPOSITORY,
      baseBranch: FIXTURE_BRANCH,
    });

    const enqueued = await requestJobRun(job.id, job.dispatchGeneration, queue);
    if (enqueued.result === null) {
      throw new Error("The job was created, but Redis did not accept its queue message.");
    }

    console.log(`Created job ${job.id}`);
    console.log(`Watching ${FIXTURE_REPOSITORY} on ${FIXTURE_BRANCH} ...`);
    await watchJob(job.id, worker);

    const finished = await getJob(job.id);
    if (!finished) throw new Error(`Job ${job.id} disappeared before the demo finished.`);
    await printArtifacts(job.id);

    if (finished.status !== "completed") {
      throw new Error(
        `Demo job ended ${finished.status}: ${finished.failureReason ?? "no failure reason"}`,
      );
    }

    console.log(`Demo completed: ${job.id}`);
  } finally {
    await stopWorker(worker);
    await closeJobQueue();
    await closeRedis();
    await closeDb();
  }
}

function assertDemoConfiguration(): void {
  if (process.env.RIVET_SANDBOX === "off") {
    throw new Error("pnpm demo:job needs RIVET_SANDBOX=docker so it can edit a real repository.");
  }
  if (process.env.RIVET_AGENT === "off") {
    throw new Error("pnpm demo:job needs RIVET_AGENT=pi so a real coding session runs.");
  }

  const provider = process.env.RIVET_MODEL_PROVIDER ?? DEFAULT_MODEL_PROVIDER;
  if (provider === DEFAULT_MODEL_PROVIDER && !process.env.OPENROUTER_API_KEY) {
    throw new Error(
      `OPENROUTER_API_KEY is required for pnpm demo:job with ${DEFAULT_MODEL}. ` +
        "Put it in .env.local or export it first.",
    );
  }
}

function startWorker(root: string): ChildProcess {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["--filter", "@rivet/worker", "start"], {
    cwd: root,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      RIVET_SANDBOX: process.env.RIVET_SANDBOX ?? "docker",
      RIVET_AGENT: process.env.RIVET_AGENT ?? "pi",
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

async function printArtifacts(jobId: string): Promise<void> {
  const artifacts = await listArtifacts(jobId);
  if (artifacts.length === 0) {
    console.log("Artifacts: none");
    return;
  }

  console.log("Artifacts:");
  for (const artifact of artifacts) {
    console.log(
      `- ${artifact.type}: ${artifact.byteSize} bytes` +
        `${artifact.truncated ? " (truncated)" : ""}`,
    );

    if (artifact.type !== "implementation_summary" && artifact.type !== "diff") continue;
    const content = await getArtifact(jobId, artifact.id);
    if (!content) continue;
    const preview = content.content.trim().replace(/\n/g, "\\n").slice(0, 240);
    console.log(`  ${preview}${content.content.length > 240 ? "..." : ""}`);
  }
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
    }, 10_000);
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
