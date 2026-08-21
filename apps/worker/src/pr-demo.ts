/* eslint-disable no-console -- this command is a local end-to-end transcript */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import type { Issue, JobStatus, Repository } from "@rivet/contracts";
import { createJob, getJob, listEvents, requestJobRun } from "@rivet/core";
import { closeDb } from "@rivet/database";
import { createGitHubClient } from "@rivet/github";
import { closeJobQueue, closeRedis, getBullJobQueue, type BullJobQueue } from "@rivet/queue";

import { DEFAULT_MODEL, DEFAULT_MODEL_PROVIDER, loadRootEnv, parseWorkerConfig } from "./config";
import { assertLocalControlPlane } from "./demo-preflight";
import { selectDemoTask } from "./demo-tasks";

/**
 * Milestone 9's demo: acceptance run B against real GitHub.
 *
 * `job-demo.ts`'s structure exactly - the real worker as a child, the job
 * created here, the timeline tailed - with three differences. It asserts the
 * App configuration up front and names what is missing, it creates the job with
 * an installation binding rather than a bare `repoUrl`, and it prints the pull
 * request URL as its final line.
 *
 * It deletes nothing. The branch and the pull request are the milestone's
 * output, and a demo that tidies up after itself leaves nothing to look at. The
 * target is a throwaway repository for exactly that reason; clean it by hand
 * between runs, or let the branches accumulate.
 */

const DEFAULT_TARGET = "xuanhieu2611/rivet-demo-reservations";
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exceeded",
]);

async function main(): Promise<void> {
  loadRootEnv();
  assertDemoConfiguration();
  const workerConfig = parseWorkerConfig(process.env);

  const target = parseTarget(process.env.RIVET_DEMO_REPO ?? DEFAULT_TARGET);
  const client = createGitHubClient({
    appConfig: {
      appId: workerConfig.github.appId ?? "",
      privateKey: workerConfig.github.privateKey ?? "",
    },
  });

  const { installationId, repository } = await resolveInstallation(client, target);
  console.log(
    `Using installation ${installationId} for ${repository.owner}/${repository.name} ` +
      `(${repository.private ? "private" : "public"}, default ${repository.defaultBranch})`,
  );

  const issue = await selectIssue(client, installationId, repository);
  const task = issue
    ? { id: `issue-${issue.number}`, title: issue.title, description: issue.body ?? issue.title }
    : selectDemoTask(process.env.RIVET_DEMO_TASK);
  if (issue) console.log(`Working from issue #${issue.number}: ${issue.title}`);

  const root = resolve(import.meta.dirname, "../../..");
  const worker = startWorker(root);
  let queue: BullJobQueue | undefined;

  try {
    queue = getBullJobQueue();
    const job = await createJob({
      title: task.title,
      description: task.description,
      repoUrl: `https://github.com/${repository.owner}/${repository.name}`,
      baseBranch: repository.defaultBranch,
      reviewMode: workerConfig.reviewMode,
      maxReviewLoops: workerConfig.maxReviewLoops,
      githubInstallationId: installationId,
      repoOwner: repository.owner,
      repoName: repository.name,
      ...(issue ? { issueNumber: issue.number, issueUrl: issue.htmlUrl } : {}),
    });

    const enqueued = await requestJobRun(job.id, job.dispatchGeneration, queue);
    if (enqueued.result === null) {
      throw new Error("The job was created, but Redis did not accept its queue message.");
    }

    console.log(`Created job ${job.id} for task ${task.id}`);
    await watchJob(job.id, worker);

    const finished = await getJob(job.id);
    if (!finished) throw new Error(`Job ${job.id} disappeared before the demo finished.`);
    if (finished.status !== "completed") {
      throw new Error(
        `Demo job ended ${finished.status}: ${finished.failureReason ?? "no failure reason"}`,
      );
    }
    if (!finished.pullRequestUrl) {
      throw new Error("The job completed without recording a pull request URL.");
    }

    console.log(`Branch: ${finished.finalBranch ?? "(none)"}`);
    console.log(finished.pullRequestUrl);
  } finally {
    await stopWorker(worker);
    await closeJobQueue();
    await closeRedis();
    await closeDb();
  }
}

/**
 * Everything this demo needs that a laptop can be missing, named individually.
 *
 * Half of Milestone 9's failure modes are configuration, and a demo that fails
 * on its first GitHub call with a 401 has spent a container and a model session
 * to report a missing environment variable.
 */
function assertDemoConfiguration(): void {
  assertLocalControlPlane("pnpm demo:pr");

  const missing: string[] = [];
  if (process.env.RIVET_GITHUB !== "app") {
    missing.push("RIVET_GITHUB=app (publication is skipped under `off`)");
  }
  if (!process.env.GITHUB_APP_ID) missing.push("GITHUB_APP_ID");
  if (!process.env.GITHUB_APP_PRIVATE_KEY) missing.push("GITHUB_APP_PRIVATE_KEY (base64 PEM)");
  if (process.env.RIVET_SANDBOX === "off") missing.push("RIVET_SANDBOX=docker");
  if (process.env.RIVET_AGENT === "off") missing.push("RIVET_AGENT=pi");

  const provider = process.env.RIVET_MODEL_PROVIDER ?? DEFAULT_MODEL_PROVIDER;
  if (provider === DEFAULT_MODEL_PROVIDER && !process.env.OPENROUTER_API_KEY) {
    missing.push(`OPENROUTER_API_KEY (for ${DEFAULT_MODEL})`);
  }

  if (missing.length > 0) {
    throw new Error(
      `pnpm demo:pr needs the following in .env.local:\n- ${missing.join("\n- ")}\n` +
        "See docs/milestone-9-setup.md.",
    );
  }
}

function parseTarget(value: string): { owner: string; name: string } {
  const [owner, name] = value.split("/");
  if (!owner || !name) {
    throw new Error(`RIVET_DEMO_REPO must be <owner>/<repo>, not ${value}.`);
  }
  return { owner, name };
}

/** The installation that can actually reach the demo repository. */
async function resolveInstallation(
  client: ReturnType<typeof createGitHubClient>,
  target: { owner: string; name: string },
): Promise<{ installationId: number; repository: Repository }> {
  const installations = await client.listInstallations();
  if (installations.length === 0) {
    throw new Error(
      "The App is not installed anywhere. Install it on the demo repository first; " +
        "see docs/milestone-9-setup.md.",
    );
  }

  for (const installation of installations) {
    const repositories = await client.listRepositories(installation.id);
    const repository = repositories.find(
      (candidate) =>
        candidate.owner.toLowerCase() === target.owner.toLowerCase() &&
        candidate.name.toLowerCase() === target.name.toLowerCase(),
    );
    if (repository) return { installationId: installation.id, repository };
  }

  throw new Error(
    `No installation of this App can reach ${target.owner}/${target.name}. ` +
      "Install it on that repository, or set RIVET_DEMO_REPO to one it can reach.",
  );
}

/** The first open issue, when there is one. An issue is a nicer demo than a prompt. */
async function selectIssue(
  client: ReturnType<typeof createGitHubClient>,
  installationId: number,
  repository: Repository,
): Promise<Issue | null> {
  if (process.env.RIVET_DEMO_ISSUE === "off") return null;

  const issues = await client.listIssues(installationId, {
    owner: repository.owner,
    name: repository.name,
  });
  const wanted = process.env.RIVET_DEMO_ISSUE;
  const open = issues.filter((issue) => issue.state === "open");
  if (wanted) {
    const chosen = open.find((issue) => issue.number === Number(wanted));
    if (!chosen) throw new Error(`Issue #${wanted} is not open on the demo repository.`);
    return chosen;
  }
  return open[0] ?? null;
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
      RIVET_GITHUB: process.env.RIVET_GITHUB ?? "app",
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
