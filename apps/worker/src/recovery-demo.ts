/* eslint-disable no-console -- this command is a local end-to-end transcript */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { JobEvent, JobStatus } from "@rivet/contracts";
import {
  createJob,
  getArtifact,
  getJob,
  getLatestCheckpoint,
  listArtifacts,
  listEvents,
  requestJobRun,
  type JobCheckpoint,
} from "@rivet/core";
import { closeDb } from "@rivet/database";
import { closeJobQueue, closeRedis, getBullJobQueue, type BullJobQueue } from "@rivet/queue";

import { loadRootEnv } from "./config";
import { assertLocalControlPlane } from "./demo-preflight";
import { assertMilestone6RecoveryEventSequence } from "./recovery-trace";

/**
 * The Milestone 6 definition of done, run locally against real infrastructure.
 *
 * The shape is `demo:job`'s - a child worker running the production entrypoint,
 * this process watching Postgres - with the one addition M6 exists for: worker
 * A is killed with `SIGKILL` the instant its first implementation turn is
 * durable, and worker B has to finish the job from what survived.
 *
 * Two deliberate choices about what this proves. The agent is scripted
 * (`RIVET_AGENT=scripted`), because a model asked the same question twice does
 * not do the same thing twice and a recovery demo that fails when the
 * replacement session picks a different file has demonstrated nothing;
 * `demo:job` is where a real Pi session against this same fixture is proved.
 * And the replacement session makes **no edit of its own** - it verifies the
 * restored file, runs the suite and stops - so the job can only reach
 * `completed` with a `fixed` outcome if the killed worker's bytes were
 * captured, restored into a different container, and verified.
 *
 * Every fact below is checked against durable rows rather than against this
 * process's memory of what it did, and any missing one exits non-zero.
 */

const FIXTURE_REPOSITORY = "https://github.com/xuanhieu2611/rivet-fixture-node";
const FIXTURE_BRANCH = "main";

/** The phrase only the scripted recovery session produces. */
const RESUMED_SUMMARY_MARKER = "Continued the interrupted attempt";

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exceeded",
]);

/**
 * Compressed lease timings, and the floors are the schema's own.
 *
 * A five-second lease with a one-second heartbeat still satisfies
 * `heartbeat * 3 <= lease`, so the protocol under demonstration is the
 * production one running fast, not a relaxed version of it. The reap grace is
 * compressed for the same reason: the orphaned container has to be provably
 * gone before a demo that takes a minute can end.
 */
const DEMO_TIMINGS = {
  WORKER_CONCURRENCY: "1",
  WORKER_LEASE_SECONDS: "5",
  WORKER_HEARTBEAT_SECONDS: "1",
  WORKER_SWEEP_INTERVAL_MS: "1000",
  WORKER_MAX_ATTEMPTS: "3",
  RIVET_PIPELINE_SPEED: "0",
  SANDBOX_REAP_GRACE_MS: "1000",
} as const;

const CHECKPOINT_WAIT_MS = 600_000;
const COMPLETION_WAIT_MS = 900_000;

type RecoveryFacts = Record<string, { ok: boolean; detail: string }>;

async function main(): Promise<void> {
  loadRootEnv();
  assertDemoConfiguration();

  const root = resolve(import.meta.dirname, "../../..");
  const scriptPath = resolve(import.meta.dirname, "recovery-demo-agent.ts");
  let queue: BullJobQueue | undefined;
  let workerA: ChildProcess | undefined;
  let workerB: ChildProcess | undefined;

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
      // This demo isolates M6 recovery. Its scripted agent intentionally has
      // no reviewer session, so the job opts out of M8 review explicitly.
      reviewMode: "none",
      maxReviewLoops: 0,
    });

    console.log(`Created job ${job.id}`);
    workerA = startWorker(root, scriptPath, "A");

    const enqueued = await requestJobRun(job.id, job.dispatchGeneration, queue);
    if (enqueued.result === null) {
      throw new Error("The job was created, but Redis did not accept its queue message.");
    }

    console.log("Worker A is running. Waiting for the first implementation checkpoint ...");
    let cursor = await follow(job.id, 0);
    const checkpoint = await waitFor(
      async () => {
        cursor = await follow(job.id, cursor);
        const latest = await getLatestCheckpoint(job.id, { maxBytes: 4 * 1_024 * 1_024 });
        return latest?.kind === "agent_turn" && latest.patchByteSize > 0 ? latest : null;
      },
      {
        timeoutMs: CHECKPOINT_WAIT_MS,
        label: "a non-empty implementation checkpoint",
        worker: workerA,
      },
    );
    console.log(
      `Checkpoint ${checkpoint.sequence}: ${checkpoint.patchByteSize} bytes of workspace patch ` +
        `from sandbox ${short(checkpoint.sandboxId)} at ${short(checkpoint.baseCommitSha)}.`,
    );

    const killed = await kill(workerA);
    workerA = undefined;
    console.log(`Killed worker A (${killed}). Its container is now orphaned.`);

    workerB = startWorker(root, scriptPath, "B");
    console.log("Worker B is running. Waiting for the reclaim, the restore and the finish ...");
    await waitForTerminal(job.id, cursor, workerB);

    const facts = await collectFacts(job.id, checkpoint, killed);
    printTimeline(await listEvents(job.id, { limit: 500 }));
    report(facts);

    const failed = Object.entries(facts).filter(([, fact]) => !fact.ok);
    if (failed.length > 0) {
      throw new Error(
        `The recovery demo did not prove: ${failed.map(([name]) => name).join(", ")}`,
      );
    }
    console.log(`\nRecovery demo passed: ${job.id}`);
  } finally {
    await stopWorker(workerA);
    await stopWorker(workerB);
    await closeJobQueue();
    await closeRedis();
    await closeDb();
  }
}

/**
 * The demo runs against Docker and a scripted agent, and refuses a sandbox substitute.
 *
 * `RIVET_SANDBOX=off` would leave nothing to snapshot, so the whole
 * demonstration would pass while proving nothing. `startWorker` always overrides
 * the configured agent with the scripted recovery agent, so the normal
 * `RIVET_AGENT=pi` development setting cannot introduce model sampling here.
 */
function assertDemoConfiguration(): void {
  assertLocalControlPlane("pnpm demo:recovery");

  if (process.env.RIVET_SANDBOX === "off") {
    throw new Error(
      "pnpm demo:recovery needs RIVET_SANDBOX=docker: with no sandbox there is no workspace to " +
        "checkpoint and nothing for the replacement worker to restore.",
    );
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("pnpm demo:recovery kills a worker on purpose. Do not run it in production.");
  }
}

function startWorker(root: string, scriptPath: string, label: string): ChildProcess {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["--filter", "@rivet/worker", "start"], {
    cwd: root,
    // Its own process group, so `SIGKILL` reaches the pnpm wrapper and the tsx
    // process under it. Killing only the wrapper would leave the worker alive
    // and the demo would be watching a job nobody abandoned.
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...DEMO_TIMINGS,
      RIVET_SANDBOX: "docker",
      RIVET_AGENT: "scripted",
      RIVET_AGENT_SCRIPT: scriptPath,
      // The demo's product is the event transcript this process prints. Two
      // workers logging every phase at `info` into the same terminal buries it,
      // so they are quiet unless someone asked otherwise.
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  child.once("error", (error) => {
    console.error(`[worker ${label}] ${error.message}`);
  });
  return child;
}

/** `kill -9` on the whole group, and the signal the child actually died of. */
async function kill(worker: ChildProcess): Promise<string> {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    throw new Error("Worker A exited on its own before the demo could kill it.");
  }

  const exited = new Promise<string>((resolveExit) => {
    worker.once("exit", (code, signal) => resolveExit(signal ?? `code ${code ?? "none"}`));
  });
  if (process.platform === "win32" || worker.pid === undefined) {
    worker.kill("SIGKILL");
  } else {
    process.kill(-worker.pid, "SIGKILL");
  }
  return exited;
}

/** Prints every new event and returns the new cursor. */
async function follow(jobId: string, cursor: number): Promise<number> {
  const events = await listEvents(jobId, { after: cursor, limit: 200 });
  let next = cursor;
  for (const event of events) {
    next = event.id;
    console.log(`[${event.type}] ${event.message}`);
  }
  return next;
}

async function waitForTerminal(
  jobId: string,
  from: number,
  worker: ChildProcess,
): Promise<JobStatus> {
  let cursor = from;
  return waitFor(
    async () => {
      cursor = await follow(jobId, cursor);
      const job = await getJob(jobId);
      if (!job) throw new Error(`Job ${jobId} disappeared while it was running.`);
      return TERMINAL_STATUSES.has(job.status) ? job.status : null;
    },
    { timeoutMs: COMPLETION_WAIT_MS, label: "the job to reach a terminal status", worker },
  );
}

/**
 * Everything the milestone claims, read back out of Postgres and Docker.
 *
 * Deliberately not "the job completed, so it must have worked": a run that
 * quietly started over and got to green would also complete, and M6 is not
 * satisfied by that. Each fact below is one of the distinctions that separates
 * resumption from a second attempt.
 */
async function collectFacts(
  jobId: string,
  checkpoint: JobCheckpoint,
  killSignal: string,
): Promise<RecoveryFacts> {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} disappeared before the demo could check it.`);

  const events = await listEvents(jobId, { limit: 500 });
  const restored = last(events, "checkpoint.restored");
  const resumed = last(events, "run.resumed");
  const reclaimed = last(events, "job.reclaimed");
  const plan = last(events, "plan.recorded");
  const validation = last(events, "validation.recorded");
  const original = text(restored, "originalSandboxId");
  const replacement = text(restored, "replacementSandboxId");
  const started = phaseStarts(events);
  const summary = await readSummary(jobId);
  const containers = await liveContainers(jobId);

  return {
    "a structured plan was persisted": {
      ok: plan !== null && (await hasPlanArtifact(jobId)),
      detail: plan?.message ?? "no plan.recorded event",
    },
    "the interrupted turn left a non-empty checkpoint": {
      ok: checkpoint.kind === "agent_turn" && checkpoint.patchByteSize > 0,
      detail: `checkpoint ${checkpoint.sequence}, ${checkpoint.patchByteSize} bytes`,
    },
    "worker A was terminated uncleanly": {
      ok: killSignal === "SIGKILL",
      detail: `worker A exited on ${killSignal}`,
    },
    "the expired lease was reclaimed": {
      ok: reclaimed !== null && job.attemptCount >= 2,
      detail: `${job.attemptCount} attempts; ${reclaimed?.message ?? "no job.reclaimed event"}`,
    },
    "the reclaim advanced the dispatch generation": {
      ok: job.dispatchGeneration >= 1,
      detail: `dispatch generation ${job.dispatchGeneration}`,
    },
    "the base commit did not change": {
      ok:
        job.baseCommitSha === checkpoint.baseCommitSha &&
        text(restored, "commitSha") === checkpoint.baseCommitSha,
      detail: `${short(job.baseCommitSha ?? "none")} on both attempts`,
    },
    "recovery rebuilt the sandbox rather than reusing it": {
      ok:
        original !== null &&
        replacement !== null &&
        original !== replacement &&
        original === checkpoint.sandboxId,
      detail: `${short(original ?? "?")} -> ${short(replacement ?? "?")}`,
    },
    "the restored patch matched its checksum": {
      ok: restored !== null && text(restored, "patchSha256") === checkpoint.patchSha256,
      detail: `sha256 ${checkpoint.patchSha256.slice(0, 12)} verified after apply`,
    },
    "the run resumed at the checkpointed phase": {
      ok: resumed !== null,
      detail: resumed?.message ?? "no run.resumed event",
    },
    "analysis and planning were not rerun": {
      ok: started("Establish test baseline") === 1 && started("Create plan") === 1,
      detail:
        `baseline started ${started("Establish test baseline")}x, ` +
        `planning ${started("Create plan")}x, implementing ${started("Implement change")}x`,
    },
    "a fresh session continued the restored work": {
      ok: summary?.includes(RESUMED_SUMMARY_MARKER) === true,
      detail: summary ? summary.slice(0, 96) : "no implementation summary artifact",
    },
    "budgets counted both attempts": {
      ok: job.totalTurns >= 3 && job.totalModelCalls >= 3,
      detail: `${job.totalTurns} turns, ${job.totalModelCalls} model calls, $${job.totalCostUsd}`,
    },
    "validation fixed the seeded bug": {
      ok: validation !== null && text(validation, "validation") === "fixed",
      detail: validation?.message ?? "no validation.recorded event",
    },
    "the job completed": {
      ok: job.status === "completed",
      detail: `${job.status}${job.failureReason ? `: ${job.failureReason}` : ""}`,
    },
    "both containers were destroyed": {
      ok: containers.length === 0,
      detail: containers.length === 0 ? "no container left for this job" : containers.join(", "),
    },
    // The Stage 0 acceptance trace, checked in order against the real run
    // rather than restated here: it is the one assertion later stages were not
    // allowed to weaken, so this is where it has to hold.
    "the milestone trace is complete and in order": traceFact(events),
  };
}

function traceFact(events: readonly JobEvent[]): { ok: boolean; detail: string } {
  try {
    assertMilestone6RecoveryEventSequence(
      events.map((event) => ({ type: event.type, data: event.data ?? null })),
    );
    return { ok: true, detail: "every acceptance milestone, in order" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function hasPlanArtifact(jobId: string): Promise<boolean> {
  const artifacts = await listArtifacts(jobId);
  return artifacts.some((artifact) => artifact.type === "implementation_plan");
}

async function readSummary(jobId: string): Promise<string | null> {
  const artifacts = await listArtifacts(jobId);
  const summary = artifacts.filter((a) => a.type === "implementation_summary").at(-1);
  if (!summary) return null;
  const content = await getArtifact(jobId, summary.id);
  return content?.content ?? null;
}

/**
 * Containers still carrying this job's label.
 *
 * Through the CLI rather than dockerode: the demo is checking the daemon's own
 * account of what is left behind, and doing that through the same client the
 * worker used to create them would be a weaker question to ask.
 */
async function liveContainers(jobId: string): Promise<string[]> {
  const grace = Number(DEMO_TIMINGS.SANDBOX_REAP_GRACE_MS) + 4_000;
  const deadline = Date.now() + grace;

  for (;;) {
    const { stdout } = await promisify(execFile)("docker", [
      "ps",
      "-a",
      "--filter",
      `label=rivet.job-id=${jobId}`,
      "--format",
      "{{.ID}} {{.Status}}",
    ]);
    const rows = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (rows.length === 0 || Date.now() > deadline) return rows;
    // The orphan outlives the run by design: the reaper leaves a container
    // alone until it is older than the grace period, so this waits out exactly
    // that rather than declaring a leak the next sweep would have cleaned up.
    await sleep(1_000);
  }
}

function printTimeline(events: readonly JobEvent[]): void {
  const interesting = new Set([
    "job.created",
    "job.enqueued",
    "job.claimed",
    "baseline.recorded",
    "plan.recorded",
    "checkpoint.created",
    "job.reclaimed",
    "checkpoint.restored",
    "checkpoint.rejected",
    "run.resumed",
    "validation.recorded",
    "run.summarized",
    "job.completed",
    "job.failed",
  ]);

  console.log("\nRecovery timeline");
  console.log("-----------------");
  for (const event of events) {
    if (!interesting.has(event.type)) continue;
    console.log(`  ${event.type.padEnd(20)} ${event.message}`);
  }
}

function report(facts: RecoveryFacts): void {
  console.log("\nDefinition of done");
  console.log("------------------");
  for (const [name, fact] of Object.entries(facts)) {
    console.log(`  ${fact.ok ? "PASS" : "FAIL"}  ${name} (${fact.detail})`);
  }
}

function last(events: readonly JobEvent[], type: string): JobEvent | null {
  return events.filter((event) => event.type === type).at(-1) ?? null;
}

function text(event: JobEvent | null, key: string): string | null {
  const data: Record<string, unknown> = event?.data ?? {};
  const value = data[key];
  return typeof value === "string" ? value : null;
}

/** How many times a named phase was entered, across every attempt. */
function phaseStarts(events: readonly JobEvent[]): (phase: string) => number {
  const starts = events.filter((event) => event.type === "phase.started");
  return (phase) => starts.filter((event) => event.data?.phase === phase).length;
}

function short(value: string): string {
  return value.slice(0, 12);
}

interface WaitOptions {
  timeoutMs: number;
  label: string;
  /** The child this wait depends on; its death ends the wait immediately. */
  worker: ChildProcess;
}

/**
 * Polls Postgres, and gives up if the worker it depends on has died.
 *
 * The second half matters more than it looks: without it, a worker that exits
 * on a configuration error turns every failure in this demo into the same
 * fifteen-minute timeout with no explanation.
 */
async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  options: WaitOptions,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const worker = options.worker;

  for (;;) {
    const result = await check();
    if (result) return result;
    if (worker.exitCode !== null) {
      throw new Error(
        `The worker exited (code ${worker.exitCode}) while waiting for ${options.label}.`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${options.timeoutMs}ms waiting for ${options.label}.`);
    }
    await sleep(500);
  }
}

async function stopWorker(worker: ChildProcess | undefined): Promise<void> {
  if (worker?.exitCode !== null || worker.signalCode !== null) return;

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
