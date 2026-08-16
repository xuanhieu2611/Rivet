import { execFile, spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { JobEvent } from "@rivet/contracts";
import { approvingReview, FakeCodingAgent } from "@rivet/agent";
import { deriveBranchName, getArtifact, listArtifacts, requestJobRun } from "@rivet/core";
import { db, jobExternalEffects } from "@rivet/database";
import type { FakeGitHubClient } from "@rivet/github";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  APP_BASE_URL,
  createRemoteFixture,
  INSTALLATION_ID,
  ISSUE_NUMBER,
  ISSUE_URL,
  publicationClient,
  publicationGitHub,
  publicationPipeline,
  publicationSandbox,
  type CaptureVariant,
  type RemoteFixture,
  REPO_NAME,
  REPO_OWNER,
  SENTINEL_TOKEN,
} from "./publication-fixture";
import { successfulSession } from "./review-fixture";
import {
  closeConnections,
  createTestJob,
  createTestQueue,
  patchTestJob,
  readEvents,
  readJob,
  resetDatabase,
  startTestWorker,
  type TestQueue,
  type TestWorker,
  waitForStatus,
} from "./support";

/**
 * Milestone 9's acceptance runs, through the production processor.
 *
 * Postgres, Redis, BullMQ, the lease, every phase context, and - the part that
 * makes this suite worth its runtime - the real host Git operations against a
 * real bare repository standing in for GitHub. The sandbox, the model and the
 * provider API are scripted; the patch, the apply, the commit and the push are
 * not. See `docs/plans/milestone-9-acceptance.md`, whose eight runs these are.
 *
 * Run H needs a real container and lives in `pipeline.sbx.test.ts`.
 */

const CRASH_WORKER = resolve(import.meta.dirname, "publication-crash-worker.ts");
const runFile = promisify(execFile);

/** The contract's projection set: everything else in the log is ignored. */
const PROJECTED_TYPES = new Set([
  "job.claimed",
  "phase.started",
  "phase.completed",
  "validation.recorded",
  "review.recorded",
  "checkpoint.restored",
  "run.resumed",
  "github.repository_bound",
  "branch.created",
  "commit.created",
  "push.completed",
  "pull_request.opened",
  "pull_request.adopted",
  "publication.skipped",
  "external_effect.recorded",
  "run.summarized",
  "job.completed",
  "job.failed",
  "job.reclaimed",
]);

/** The publication tail of the projection, which is all M9 changes. */
const PUBLICATION_TYPES = new Set([
  "github.repository_bound",
  "branch.created",
  "commit.created",
  "push.completed",
  "pull_request.opened",
  "pull_request.adopted",
  "publication.skipped",
  "external_effect.recorded",
]);

let fixture: RemoteFixture;
let testQueue: TestQueue;
let worker: TestWorker | undefined;
const children: ChildProcess[] = [];

beforeAll(async () => {
  fixture = await createRemoteFixture();
  testQueue = createTestQueue("publication", { backoff: { type: "fixed", delay: 20 } });
});

afterAll(async () => {
  await testQueue.destroy();
  await closeConnections();
  await fixture.destroy();
});

beforeEach(async () => {
  await resetDatabase();
  await db.delete(jobExternalEffects);
  await resetRemote();
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
  await Promise.all(children.splice(0).map(stopChild));
});

describe("Milestone 9 publication acceptance contract", () => {
  it("A: skips publication for a job with no installation binding", async () => {
    const client = publicationClient();
    const job = await createTestJob({ title: "Unbound publication job" });
    const finished = await runJob(job.id, { client, variant: fixture.first });

    expect(finished.status).toBe("completed");
    expect(publicationProjection(await readEvents(job.id))).toEqual([
      "run.summarized",
      "publication.skipped",
    ]);
    expect(eventOf(await readEvents(job.id), "publication.skipped").data).toMatchObject({
      reason: "no_installation",
    });
    expect(finished.finalBranch).toBeNull();
    expect(finished.pullRequestUrl).toBeNull();
    expect(finished.pullRequestNumber).toBeNull();
    await expect(effectsFor(job.id)).resolves.toHaveLength(0);
    // The line worth writing: a job with nothing bound must not so much as ask
    // GitHub a question.
    expect(client.calls).toEqual([]);
  });

  it("A: skips publication when the worker has GitHub disabled", async () => {
    const client = publicationClient();
    const job = await createBoundJob();
    // No `github` in the pipeline options at all, which is `RIVET_GITHUB=off`.
    const finished = await runJob(job.id, { client, variant: fixture.first, githubOff: true });

    expect(finished.status).toBe("completed");
    expect(eventOf(await readEvents(job.id), "publication.skipped").data).toMatchObject({
      reason: "github_off",
    });
    expect(finished.finalBranch).toBeNull();
    await expect(effectsFor(job.id)).resolves.toHaveLength(0);
    expect(client.calls).toEqual([]);
  });

  it("B: publishes the validated tree and opens a pull request", async () => {
    const client = publicationClient();
    const job = await createBoundJob({ title: "Fix the sum" });
    const branch = deriveBranchName(job.id, "Fix the sum");
    const finished = await runJob(job.id, { client, variant: fixture.first });

    expect(finished.status).toBe("completed");
    const events = await readEvents(job.id);
    expect(publicationProjection(events)).toEqual([
      "github.repository_bound",
      "run.summarized",
      "branch.created",
      "commit.created",
      "push.completed",
      "external_effect.recorded",
      "pull_request.opened",
      "external_effect.recorded",
    ]);

    expect(eventOf(events, "github.repository_bound").data).toMatchObject({
      installationId: INSTALLATION_ID,
      owner: REPO_OWNER,
      repo: REPO_NAME,
      private: false,
      issueNumber: ISSUE_NUMBER,
    });
    expect(eventOf(events, "branch.created").data).toMatchObject({
      branch,
      baseBranch: "main",
      baseCommitSha: fixture.baseCommitSha,
    });
    const commit = eventOf(events, "commit.created");
    expect(commit.data).toMatchObject({ branch, treeSha: fixture.first.treeSha });
    expect(eventOf(events, "push.completed").data).toMatchObject({
      branch,
      treeSha: fixture.first.treeSha,
      forced: false,
    });
    expect(eventOf(events, "pull_request.opened").data).toMatchObject({
      number: 1,
      state: "open",
      branch,
    });

    // The job row, and the two receipts.
    expect(finished.finalBranch).toBe(branch);
    expect(finished.pullRequestNumber).toBe(1);
    expect(finished.pullRequestUrl).toBe(eventOf(events, "pull_request.opened").data?.url);
    const effects = await effectsFor(job.id);
    expect(effects.map((effect) => effect.kind).sort()).toEqual([
      "branch_pushed",
      "pull_request_opened",
    ]);

    // The remote, which is the assertion the local bare repository exists for.
    const commitSha = String(commit.data?.commitSha);
    expect(await remoteBranches()).toEqual([branch]);
    expect(await gitRemote(["rev-parse", branch])).toBe(commitSha);
    expect(await gitRemote(["rev-parse", `${branch}^{tree}`])).toBe(fixture.first.treeSha);
    expect(await gitRemote(["rev-parse", `${branch}^`])).toBe(fixture.baseCommitSha);
    expect(await gitRemote(["show", "-s", "--format=%an%n%ae", branch])).toContain("Rivet");
    expect(await gitRemote(["show", "-s", "--format=%an%n%ae", branch])).not.toContain(
      "Fixture Author",
    );

    // The body, asserted by structure: every element §6.9 requires is a record
    // that already existed before `finalizing` ran.
    const body = await pullRequestBody(job.id);
    expect(body).toContain(job.id);
    expect(body).toContain(`${APP_BASE_URL}/jobs/${job.id}`);
    expect(body).toContain(fixture.first.path);
    expect(body.toLowerCase()).toContain("test");
    expect(body).not.toContain(SENTINEL_TOKEN);

    // The artifact and the posted body are the same string.
    const created = client.calls.find((call) => call.method === "createPullRequest");
    expect(created?.input && "body" in created.input ? created.input.body : null).toBe(body);
  });

  it("C: adopts its own branch after a crash between the push and the receipt", async () => {
    const job = await createBoundJob({ title: "Crash after push" });
    const branch = deriveBranchName(job.id, "Crash after push");
    await requestJobRun(job.id, job.dispatchGeneration, testQueue.queue);

    const crashed = await startCrashWorker("publication-crash-a", "kill-after-push", fixture.first);
    expect(await waitForChildExit(crashed)).toBe("SIGKILL");
    // The push really happened; only its receipt did not.
    expect(await remoteBranches()).toEqual([branch]);
    const pushedSha = await gitRemote(["rev-parse", branch]);
    await expect(effectsFor(job.id)).resolves.toHaveLength(0);

    const client = publicationClient({
      refs: { [`${REPO_OWNER}/${REPO_NAME}#heads/${branch}`]: await remoteRefState(branch) },
    });
    const finished = await resumeJob(job.id, { client, variant: fixture.first });

    expect(finished.status).toBe("completed");
    expect(finished.attemptCount).toBe(2);
    expect(finished.baseCommitSha).toBe(fixture.baseCommitSha);

    const events = await readEvents(job.id);
    const second = eventsOfAttempt(events, 2);
    expect(publicationProjection(second)).toEqual([
      "github.repository_bound",
      "run.summarized",
      "branch.created",
      "commit.created",
      "external_effect.recorded",
      "pull_request.opened",
      "external_effect.recorded",
    ]);
    // No `push.completed` on the second attempt: "pushed" and "was already
    // there" are different facts, and the timeline keeps them different.
    expect(second.some((event) => event.type === "push.completed")).toBe(false);
    expect(eventOf(second, "commit.created").data).toMatchObject({
      treeSha: fixture.first.treeSha,
    });
    expect(
      second.find(
        (event) =>
          event.type === "external_effect.recorded" && event.data?.kind === "branch_pushed",
      )?.data,
    ).toMatchObject({ adopted: true });

    expect(await remoteBranches()).toEqual([branch]);
    expect(await gitRemote(["rev-parse", branch])).toBe(pushedSha);
    expect(client.calls.filter((call) => call.method === "createPullRequest")).toHaveLength(1);
    await expect(effectsFor(job.id)).resolves.toHaveLength(2);
  });

  it("C: keeps the branch name recoverable when the crash precedes the push", async () => {
    const job = await createBoundJob({ title: "Crash before push" });
    const branch = deriveBranchName(job.id, "Crash before push");
    await requestJobRun(job.id, job.dispatchGeneration, testQueue.queue);

    const crashed = await startCrashWorker(
      "publication-crash-b",
      "kill-before-push",
      fixture.first,
    );
    expect(await waitForChildExit(crashed)).toBe("SIGKILL");
    expect(await remoteBranches()).toEqual([]);
    // The name is the only handle a replacement has for asking GitHub what
    // already happened, so it is durable before anything external is attempted.
    expect((await readJob(job.id)).finalBranch).toBe(branch);

    const client = publicationClient();
    const finished = await resumeJob(job.id, { client, variant: fixture.first });

    expect(finished.status).toBe("completed");
    const second = eventsOfAttempt(await readEvents(job.id), 2);
    expect(eventOf(second, "push.completed").data).toMatchObject({ forced: false });
    expect(await remoteBranches()).toEqual([branch]);
  });

  it("D: force-updates the branch when the resumed tree is not the pushed one", async () => {
    const job = await createBoundJob({ title: "Resume with a new tree" });
    const branch = deriveBranchName(job.id, "Resume with a new tree");
    await requestJobRun(job.id, job.dispatchGeneration, testQueue.queue);

    const crashed = await startCrashWorker("publication-crash-c", "kill-after-push", fixture.first);
    expect(await waitForChildExit(crashed)).toBe("SIGKILL");
    const abandoned = await gitRemote(["rev-parse", branch]);

    const client = publicationClient({
      refs: { [`${REPO_OWNER}/${REPO_NAME}#heads/${branch}`]: await remoteRefState(branch) },
    });
    // The first capture is the one the restore re-derives and must match; the
    // second is the workspace this attempt validated, and it differs.
    const finished = await resumeJob(job.id, {
      client,
      variant: [fixture.first, fixture.second],
    });

    expect(finished.status).toBe("completed");
    const second = eventsOfAttempt(await readEvents(job.id), 2);
    expect(eventOf(second, "push.completed").data).toMatchObject({
      forced: true,
      treeSha: fixture.second.treeSha,
    });
    expect(
      second.find(
        (event) =>
          event.type === "external_effect.recorded" && event.data?.kind === "branch_pushed",
      )?.data,
    ).toMatchObject({ adopted: false });

    expect(await remoteBranches()).toEqual([branch]);
    const published = await gitRemote(["rev-parse", branch]);
    expect(published).not.toBe(abandoned);
    expect(await gitRemote(["rev-parse", `${branch}^{tree}`])).toBe(fixture.second.treeSha);
    // The replacement rewrites the branch onto the base rather than stacking a
    // commit on the abandoned one. A branch whose history contains a tree no
    // reviewer approved is worse than a failed job.
    expect(await gitRemote(["rev-parse", `${branch}^`])).toBe(fixture.baseCommitSha);
    await expect(gitRemote(["rev-parse", `${branch}^2`])).rejects.toThrow();
  });

  it.each([
    ["open", true],
    ["closed", false],
    ["merged", false],
  ] as const)("E: adopts an existing %s pull request", async (state, updated) => {
    const job = await createBoundJob({ title: `Adopt a ${state} request` });
    const branch = deriveBranchName(job.id, `Adopt a ${state} request`);
    const existing = {
      nodeId: "existing-node",
      number: 41,
      url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/41`,
      branch,
      state,
    };
    const client = publicationClient({ pullRequests: [existing] });
    const finished = await runJob(job.id, { client, variant: fixture.first });

    expect(finished.status).toBe("completed");
    const events = await readEvents(job.id);
    expect(eventOf(events, "pull_request.adopted").data).toMatchObject({
      number: 41,
      state,
      updated,
    });
    expect(events.some((event) => event.type === "pull_request.opened")).toBe(false);
    expect(client.calls.filter((call) => call.method === "createPullRequest")).toHaveLength(0);
    expect(client.calls.filter((call) => call.method === "updatePullRequest")).toHaveLength(
      updated ? 1 : 0,
    );
    expect(finished.pullRequestUrl).toBe(existing.url);
    expect(finished.pullRequestNumber).toBe(41);
    await expect(effectsFor(job.id)).resolves.toHaveLength(2);
    expect(
      (await effectsFor(job.id)).find((effect) => effect.kind === "pull_request_opened")
        ?.externalId,
    ).toBe("existing-node");
  });

  it("F: fails with a named category when the App can no longer read the ref", async () => {
    const client = publicationClient();
    client.fail("getRef", { status: 404, message: "Not Found" });
    const job = await createBoundJob({ title: "Uninstalled mid job" });
    const finished = await runJob(job.id, { client, variant: fixture.first });

    expect(finished.status).toBe("failed");
    expect(finished.failureCategory).toBe("github_permission_denied");
    expect(finished.failureReason).not.toContain(SENTINEL_TOKEN);
    // Nothing was created, so nothing is claimed.
    expect(finished.finalBranch).toBeNull();
    expect(await remoteBranches()).toEqual([]);
    await expect(effectsFor(job.id)).resolves.toHaveLength(0);
  });

  it("F: fails during provisioning when the installation cannot see the repository", async () => {
    const client = publicationClient({ repositories: [] });
    const job = await createBoundJob({ title: "Repository out of reach" });
    const finished = await runJob(job.id, { client, variant: fixture.first });

    expect(finished.status).toBe("failed");
    expect(finished.failureCategory).toBe("github_permission_denied");
    expect(finished.failureReason).toContain(`${REPO_OWNER}/${REPO_NAME}`);
    expect(finished.failureReason).toContain(String(INSTALLATION_ID));
    // The cheapest place to discover it: before a container exists.
    expect(finished.sandboxId).toBeNull();
  });

  it("F: does not re-run the whole attempt when GitHub is unavailable", async () => {
    const client = publicationClient();
    client.fail("getRef", { status: 503, message: "Service Unavailable" }, 10);
    const job = await createBoundJob({ title: "GitHub is down" });
    const finished = await runJob(job.id, { client, variant: fixture.first });

    expect(finished.status).toBe("failed");
    expect(finished.failureCategory).toBe("github_unavailable");
    // The bounded retry lives in the adapter, which is unit-tested against
    // recorded responses. A runner-level retry would spend a container, a clone
    // and a session to repeat one HTTP call, and print three identical
    // timelines.
    expect(finished.attemptCount).toBe(1);
    expect(client.calls.filter((call) => call.method === "getRef")).toHaveLength(1);
  });

  it("G: keeps the pushed branch when the pull request call fails", async () => {
    const client = publicationClient();
    client.fail("createPullRequest", { status: 422, message: "Validation Failed" });
    const job = await createBoundJob({ title: "Pull request refused" });
    const branch = deriveBranchName(job.id, "Pull request refused");
    const finished = await runJob(job.id, { client, variant: fixture.first });

    expect(finished.status).toBe("failed");
    expect(finished.failureCategory).toBe("pull_request_failed");
    expect(finished.finalBranch).toBe(branch);
    expect(finished.pullRequestUrl).toBeNull();
    expect(finished.pullRequestNumber).toBeNull();

    const events = await readEvents(job.id);
    expect(publicationProjection(events)).toEqual([
      "github.repository_bound",
      "run.summarized",
      "branch.created",
      "commit.created",
      "push.completed",
      "external_effect.recorded",
    ]);
    const effects = await effectsFor(job.id);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("branch_pushed");

    // The branch is deliberately not cleaned up: it is validated, reviewed
    // work, and deleting it to tidy the failure would destroy the only thing
    // the job produced.
    expect(await remoteBranches()).toEqual([branch]);
    // And the reader still sees exactly what Rivet was about to publish.
    const body = await pullRequestBody(job.id);
    expect(body).toContain(job.id);
  });
});

interface RunInput {
  client: FakeGitHubClient;
  variant: CaptureVariant | readonly CaptureVariant[];
  githubOff?: boolean;
}

/** Creates the job's run message and the worker that will claim it. */
async function runJob(jobId: string, input: RunInput) {
  const job = await readJob(jobId);
  await requestJobRun(jobId, job.dispatchGeneration, testQueue.queue);
  startPublicationWorker(input);
  return waitForStatus(jobId, ["completed", "failed"], { timeoutMs: 60_000 });
}

/** A replacement worker for a job an earlier attempt left behind. */
async function resumeJob(jobId: string, input: RunInput) {
  startPublicationWorker(input, { withSweeper: true });
  return waitForStatus(jobId, ["completed", "failed"], { timeoutMs: 60_000 });
}

function startPublicationWorker(input: RunInput, options: { withSweeper?: boolean } = {}): void {
  const github = input.githubOff ? undefined : publicationGitHub(input.client);
  worker = startTestWorker({
    queue: testQueue.queue,
    ...(options.withSweeper ? { withSweeper: true } : {}),
    phases: publicationPipeline({
      sandbox: publicationSandbox(input.variant),
      coding: new FakeCodingAgent({
        script: [successfulSession("implementation")],
        reviewerScript: { review: approvingReview() },
      }),
      ...(github ? { github } : {}),
    }),
  });
}

/**
 * A job bound to the fixture's installation and repository.
 *
 * `repoUrl` is patched rather than created, because `createJobSchema` requires
 * an https URL and this remote is a directory. Everything downstream reads the
 * column.
 */
async function createBoundJob(overrides: { title?: string } = {}) {
  const job = await createTestJob({ title: overrides.title ?? "Bound publication job" });
  await patchTestJob(job.id, {
    repoUrl: fixture.remote,
    githubInstallationId: INSTALLATION_ID,
    repoOwner: REPO_OWNER,
    repoName: REPO_NAME,
    issueNumber: ISSUE_NUMBER,
    issueUrl: ISSUE_URL,
  });
  return job;
}

function publicationProjection(events: readonly JobEvent[]): string[] {
  return events
    .filter((event) => PROJECTED_TYPES.has(event.type))
    .filter((event) => PUBLICATION_TYPES.has(event.type) || event.type === "run.summarized")
    .map((event) => event.type);
}

/** The events written after the nth `job.claimed`, which is one attempt's log. */
function eventsOfAttempt(events: readonly JobEvent[], attempt: number): JobEvent[] {
  const claims = events.filter((event) => event.type === "job.claimed");
  const claim = claims[attempt - 1];
  if (!claim) throw new Error(`Expected at least ${attempt} claims in the event log.`);
  return events.filter((event) => event.id >= claim.id);
}

function eventOf(events: readonly JobEvent[], type: string): JobEvent {
  const event = events.find((candidate) => candidate.type === type);
  if (!event) throw new Error(`Expected ${type} in the event log.`);
  return event;
}

async function effectsFor(jobId: string) {
  return db.select().from(jobExternalEffects).where(eq(jobExternalEffects.jobId, jobId));
}

async function pullRequestBody(jobId: string): Promise<string> {
  const artifact = (await listArtifacts(jobId)).find(
    (candidate) => candidate.type === "pull_request_body",
  );
  if (!artifact) throw new Error("Expected a pull_request_body artifact.");
  const full = await getArtifact(jobId, artifact.id);
  if (!full) throw new Error("The pull_request_body artifact could not be read back.");
  return full.content;
}

/** Every publication branch on the bare remote, which should never exceed one. */
async function remoteBranches(): Promise<string[]> {
  const output = await gitRemote([
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/rivet/",
  ]);
  return output.length === 0 ? [] : output.split("\n");
}

async function remoteRefState(branch: string) {
  return {
    commitSha: await gitRemote(["rev-parse", branch]),
    treeSha: await gitRemote(["rev-parse", `${branch}^{tree}`]),
  };
}

/** Removes every publication branch, so each run starts against a clean remote. */
async function resetRemote(): Promise<void> {
  for (const branch of await remoteBranches()) {
    await gitRemote(["update-ref", "-d", `refs/heads/${branch}`]);
  }
}

async function gitRemote(argv: string[]): Promise<string> {
  const { stdout } = await runFile("git", ["-C", fixture.remote, ...argv], {
    encoding: "utf8",
    maxBuffer: 8 * 1_024 * 1_024,
  });
  return stdout.trim();
}

function startCrashWorker(
  workerId: string,
  mode: "kill-after-push" | "kill-before-push",
  variant: CaptureVariant,
): Promise<ChildProcess> {
  return writeCrashFixture(workerId, variant).then((fixturePath) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CRASH_WORKER, testQueue.queue.bull.name, workerId, fixturePath, mode],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        detached: process.platform !== "win32",
        env: { ...process.env, RIVET_TEST_LOG_LEVEL: process.env.RIVET_TEST_LOG_LEVEL ?? "silent" },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    children.push(child);
    return child;
  });
}

async function writeCrashFixture(workerId: string, variant: CaptureVariant): Promise<string> {
  const path = join(fixture.root, `${workerId}.json`);
  await writeFile(path, JSON.stringify({ variant }), "utf8");
  return path;
}

function waitForChildExit(child: ChildProcess): Promise<string | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.signalCode);
  }
  return new Promise((resolveExit) => {
    child.once("exit", (_code, signal) => resolveExit(signal));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  if (process.platform === "win32") child.kill("SIGKILL");
  else process.kill(-child.pid, "SIGKILL");
  await exited;
}
