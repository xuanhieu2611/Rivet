import { buildPipeline, createJob, listCommands, listEvents } from "@rivet/core";
import { DockerSandboxProvider } from "@rivet/sandbox";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_IMAGE } from "../../src/config";
import {
  closeConnections,
  createTestQueue,
  enqueue,
  readJob,
  resetDatabase,
  startTestWorker,
  TEST_CONFIG,
  type TestQueue,
  type TestWorker,
  waitForStatus,
} from "../integration/support";
import { type GitFixture, startGitFixture } from "./fixtures/repo";

let fixture: GitFixture;
let queue: TestQueue | undefined;
let worker: TestWorker | undefined;

beforeAll(async () => {
  fixture = await startGitFixture();
});

beforeEach(async () => {
  await worker?.close();
  await queue?.destroy();
  worker = undefined;
  queue = undefined;
  await resetDatabase();
});

afterAll(async () => {
  await worker?.close();
  await queue?.destroy();
  await fixture.close();
  await closeConnections();
});

function startRealWorker(suite: string): { queue: TestQueue; worker: TestWorker } {
  const testQueue = createTestQueue(suite, { attempts: 1 });
  const sandboxConfig = {
    mode: "docker" as const,
    image: process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
    workdir: process.env.SANDBOX_WORKDIR ?? "/home/node/workspace",
    memoryBytes: 512 * 1_024 * 1_024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 128,
    commandTimeoutMs: 10_000,
    cloneTimeoutMs: 30_000,
    installTimeoutMs: 30_000,
    baselineTimeoutMs: 30_000,
    diffMaxBytes: 262_144,
    maxOutputBytes: 16_384,
  };
  const provider = new DockerSandboxProvider({
    workerId: `sandbox-pipeline-${process.pid}`,
    reapGraceMs: 0,
  });
  const phases = buildPipeline({
    sandbox: provider,
    image: sandboxConfig.image,
    workdir: sandboxConfig.workdir,
    memoryBytes: sandboxConfig.memoryBytes,
    nanoCpus: sandboxConfig.nanoCpus,
    pidsLimit: sandboxConfig.pidsLimit,
    commandTimeoutMs: sandboxConfig.commandTimeoutMs,
    cloneTimeoutMs: sandboxConfig.cloneTimeoutMs,
    installTimeoutMs: sandboxConfig.installTimeoutMs,
    baselineTimeoutMs: sandboxConfig.baselineTimeoutMs,
    diffMaxBytes: sandboxConfig.diffMaxBytes,
  });
  const testWorker = startTestWorker({
    queue: testQueue.queue,
    config: { ...TEST_CONFIG, pipelineSpeed: 0, sandbox: sandboxConfig },
    phases,
  });

  queue = testQueue;
  worker = testWorker;
  return { queue: testQueue, worker: testWorker };
}

async function createFixtureJob(variant: "green" | "failing" | "no-tests", branch = "main") {
  return createJob({
    title: `${variant} sandbox fixture`,
    description: "Run the Milestone 2 pipeline against a hermetic repository.",
    repoUrl: fixture.url(variant),
    baseBranch: branch,
  });
}

describe("real sandbox pipeline", () => {
  it("completes the demo checkpoint with the resolved commit, install, and baseline command", async () => {
    const running = startRealWorker("sandbox-e2e");
    const job = await createFixtureJob("green");
    await enqueue(running.queue.queue, job.id);

    const completed = await waitForStatus(job.id, "completed", { timeoutMs: 45_000 });
    const commands = await listCommands(job.id);
    const events = await listEvents(job.id, { limit: 500 });

    expect(completed.baseCommitSha).toBe(fixture.commit("green"));
    expect(commands.some((command) => command.argv[0] === "npm" && command.argv[1] === "ci")).toBe(
      true,
    );
    expect(
      commands.some(
        (command) =>
          // `analyzing`, not `testing`: Milestone 5 moved the baseline ahead of
          // every phase that can change a file, which is what PRD §11 C asked
          // for all along.
          command.phase === "analyzing" &&
          command.argv[0] === "npm" &&
          command.argv[1] === "run" &&
          command.argv[2] === "test",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "baseline.recorded" && event.data?.baseline === "passed",
      ),
    ).toBe(true);

    const started = events.filter((event) => event.type === "command.started");
    const completedCommands = events.filter((event) => event.type === "command.completed");
    expect(started).toHaveLength(commands.length);
    expect(completedCommands).toHaveLength(commands.length);
    for (const completedCommand of completedCommands) {
      const executionId = completedCommand.data?.commandExecutionId;
      expect(executionId).toEqual(expect.any(String));
      expect(started.some((event) => event.data?.commandExecutionId === executionId)).toBe(true);
    }
  });

  it("records a red baseline without failing the job", async () => {
    const running = startRealWorker("sandbox-red-baseline");
    const job = await createFixtureJob("failing");
    await enqueue(running.queue.queue, job.id);

    await waitForStatus(job.id, "completed", { timeoutMs: 45_000 });
    const events = await listEvents(job.id, { limit: 500 });
    expect(
      events.some(
        (event) => event.type === "baseline.recorded" && event.data?.baseline === "failed",
      ),
    ).toBe(true);
  });

  it("classifies a nonexistent branch as terminal repo_unavailable", async () => {
    const running = startRealWorker("sandbox-missing-branch");
    const job = await createFixtureJob("green", "does-not-exist");
    await enqueue(running.queue.queue, job.id);

    const failed = await waitForStatus(job.id, "failed", { timeoutMs: 45_000 });
    expect(failed.failureCategory).toBe("repo_unavailable");
    expect((await readJob(job.id)).attemptCount).toBe(1);
  });
});
