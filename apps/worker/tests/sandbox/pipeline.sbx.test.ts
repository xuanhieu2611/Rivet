import { FakeCodingAgent } from "@rivet/agent";
import {
  parseSerializedBaselineReport,
  parseSerializedValidationReport,
  type ArtifactType,
  type CheckComparison,
} from "@rivet/contracts";
import {
  buildPipeline,
  createJob,
  getArtifact,
  listArtifacts,
  listCommands,
  listEvents,
  type AgentOptions,
  type ImplementerAgentToolbox,
} from "@rivet/core";
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
import { type FixtureVariant, type GitFixture, startGitFixture } from "./fixtures/repo";

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

function startRealWorker(
  suite: string,
  options: { agent?: AgentOptions; artifactMaxBytes?: number } = {},
): { queue: TestQueue; worker: TestWorker } {
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
    checkTimeoutMs: 30_000,
    diffMaxBytes: 262_144,
    validationReportMaxBytes: 1_048_576,
    targetedMaxFiles: 25,
    maxOutputBytes: 16_384,
    // The provider below reaps immediately; this suite builds its own.
    reapGraceMs: 0,
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
    checkTimeoutMs: sandboxConfig.checkTimeoutMs,
    diffMaxBytes: sandboxConfig.diffMaxBytes,
    validationReportMaxBytes: sandboxConfig.validationReportMaxBytes,
    targetedMaxFiles: sandboxConfig.targetedMaxFiles,
    ...(options.agent ? { agent: options.agent } : {}),
  });
  const testWorker = startTestWorker({
    queue: testQueue.queue,
    config: {
      ...TEST_CONFIG,
      pipelineSpeed: 0,
      sandbox: sandboxConfig,
      ...(options.artifactMaxBytes === undefined
        ? {}
        : { artifactMaxBytes: options.artifactMaxBytes }),
    },
    phases,
  });

  queue = testQueue;
  worker = testWorker;
  return { queue: testQueue, worker: testWorker };
}

async function createFixtureJob(variant: FixtureVariant, branch = "main") {
  return createJob({
    title: `${variant} sandbox fixture`,
    description: "Run the Milestone 2 pipeline against a hermetic repository.",
    repoUrl: fixture.url(variant),
    baseBranch: branch,
  });
}

function editingAgent(
  edit: (tools: ImplementerAgentToolbox, signal: AbortSignal) => Promise<void>,
): AgentOptions {
  return {
    coding: new FakeCodingAgent({
      script: [
        {
          events: [
            {
              type: "assistant_message",
              turn: 0,
              text: "Applied the scripted acceptance change.",
            },
          ],
          useTools: edit,
        },
      ],
    }),
    sessionTimeoutMs: 30_000,
    maxTurns: 4,
    previewMaxBytes: 512,
    fileMaxBytes: 16_384,
  };
}

function harmlessEditingAgent(): AgentOptions {
  return editingAgent(async (tools, signal) => {
    await tools.writeFile(
      "/home/node/workspace/repo/acceptance-change.js",
      "export const acceptanceChange = true;\n",
      signal,
    );
  });
}

async function reportArtifact(jobId: string, type: ArtifactType) {
  const artifacts = await listArtifacts(jobId);
  const metadata = artifacts.find((artifact) => artifact.type === type);
  if (!metadata) throw new Error(`Expected ${type} artifact.`);
  const artifact = await getArtifact(jobId, metadata.id);
  if (!artifact) throw new Error(`Could not read ${type} artifact.`);
  return artifact;
}

function comparisonsByKind(checks: CheckComparison[]) {
  return Object.fromEntries(checks.map((check) => [check.kind, check])) as Record<
    CheckComparison["kind"],
    CheckComparison
  >;
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

  it("captures and truncates a real diff while preserving its true byte size", async () => {
    const artifactMaxBytes = 1_024;
    const generated = `${"const generated = true;\n".repeat(1_000)}\n`;
    const agent = new FakeCodingAgent({
      script: [
        {
          events: [
            {
              type: "session_started",
              sessionId: "sandbox-diff-session",
              model: "fixture-model",
              provider: "fixture-provider",
              toolNames: ["bash", "edit", "read", "write"],
            },
            {
              type: "assistant_message",
              turn: 0,
              text: "Added a generated module and verified the repository tests.",
            },
            {
              type: "session_ended",
              reason: "completed",
              turns: 1,
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0,
              },
            },
          ],
          useTools: async (tools, signal) => {
            await tools.writeFile("/home/node/workspace/repo/generated.js", generated, signal);
          },
        },
      ],
    });
    const agentOptions: AgentOptions = {
      coding: agent,
      sessionTimeoutMs: 30_000,
      maxTurns: 4,
      previewMaxBytes: 512,
      fileMaxBytes: 16_384,
    };
    const running = startRealWorker("sandbox-m5-diff", {
      agent: agentOptions,
      artifactMaxBytes,
    });
    const job = await createFixtureJob("green");
    await enqueue(running.queue.queue, job.id);

    await waitForStatus(job.id, "completed", { timeoutMs: 45_000 });
    const artifacts = await listArtifacts(job.id);
    const diff = artifacts.find((artifact) => artifact.type === "diff");
    if (!diff) throw new Error("Expected the validation diff artifact.");

    expect(diff.truncated).toBe(true);
    expect(diff.byteSize).toBeGreaterThan(artifactMaxBytes);
    expect(diff.metadata).toMatchObject({ filesChanged: 1 });

    const stored = await getArtifact(job.id, diff.id);
    expect(stored?.content).toContain("bytes elided");
    expect(Buffer.byteLength(stored?.content ?? "", "utf8")).toBeLessThan(diff.byteSize);

    const events = await listEvents(job.id, { limit: 500 });
    expect(events.find((event) => event.type === "validation.recorded")?.data).toMatchObject({
      // The green M7 fixture runs all three binding checks before and after.
      validation: "verified",
      filesChanged: 1,
    });
    expect(
      events.find(
        (event) => event.type === "validation.check_recorded" && event.data?.check === "test",
      )?.data,
    ).toMatchObject({ checkOutcome: "verified" });
    expect(events.some((event) => event.type === "run.summarized")).toBe(true);
  });

  it("runs a green multi-check baseline and comparison through the real pipeline", async () => {
    const running = startRealWorker("sandbox-m7-green", { agent: harmlessEditingAgent() });
    const job = await createFixtureJob("green");
    await enqueue(running.queue.queue, job.id);

    await waitForStatus(job.id, "completed", { timeoutMs: 45_000 });
    const baseline = parseSerializedBaselineReport(
      (await reportArtifact(job.id, "baseline_report")).content,
    );
    const validation = parseSerializedValidationReport(
      (await reportArtifact(job.id, "validation_report")).content,
    );

    expect(baseline.checks.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: "test", status: "passed" },
      { kind: "typecheck", status: "passed" },
      { kind: "lint", status: "passed" },
    ]);
    expect(comparisonsByKind(validation.checks)).toMatchObject({
      test: { status: "passed", outcome: "verified" },
      typecheck: { status: "passed", outcome: "verified" },
      lint: { status: "passed", outcome: "verified" },
    });
  });

  it("keeps a no-check repository green with every comparison unverified", async () => {
    const running = startRealWorker("sandbox-m7-no-tests", { agent: harmlessEditingAgent() });
    const job = await createFixtureJob("no-tests");
    await enqueue(running.queue.queue, job.id);

    await waitForStatus(job.id, "completed", { timeoutMs: 45_000 });
    const baseline = parseSerializedBaselineReport(
      (await reportArtifact(job.id, "baseline_report")).content,
    );
    const validation = parseSerializedValidationReport(
      (await reportArtifact(job.id, "validation_report")).content,
    );

    expect(baseline.checks.every((check) => check.status === "skipped")).toBe(true);
    expect(validation.outcome).toBe("unverified");
    expect(validation.checks).toHaveLength(4);
    expect(validation.checks.every((check) => check.outcome === "unverified")).toBe(true);
  });

  it("fails an unchanged red suite as unresolved after recording every check", async () => {
    const running = startRealWorker("sandbox-m7-failing", { agent: harmlessEditingAgent() });
    const job = await createFixtureJob("failing");
    await enqueue(running.queue.queue, job.id);

    const failed = await waitForStatus(job.id, "failed", { timeoutMs: 45_000 });
    const validation = parseSerializedValidationReport(
      (await reportArtifact(job.id, "validation_report")).content,
    );

    expect(failed.failureCategory).toBe("validation_failed");
    expect(comparisonsByKind(validation.checks)).toMatchObject({
      test: { status: "failed", outcome: "unresolved" },
      typecheck: { status: "passed", outcome: "verified" },
      lint: { status: "passed", outcome: "verified" },
    });
  });

  it("attributes a fixed failure while preserving the other pre-existing failure", async () => {
    const agent = editingAgent(async (tools, signal) => {
      const path = "/home/node/workspace/repo/calculator.js";
      const current = await tools.readFile(path, signal);
      await tools.writeFile(
        path,
        current.content.replace("fixable = false", "fixable = true"),
        signal,
      );
    });
    const running = startRealWorker("sandbox-m7-attribution-fix", { agent });
    const job = await createFixtureJob("attribution");
    await enqueue(running.queue.queue, job.id);

    const failed = await waitForStatus(job.id, "failed", { timeoutMs: 45_000 });
    const baseline = parseSerializedBaselineReport(
      (await reportArtifact(job.id, "baseline_report")).content,
    );
    const validation = parseSerializedValidationReport(
      (await reportArtifact(job.id, "validation_report")).content,
    );
    const test = comparisonsByKind(validation.checks).test;
    const events = await listEvents(job.id, { limit: 500 });
    const checkSequence = events
      .filter(
        (event) =>
          event.type === "baseline.check_recorded" || event.type === "validation.check_recorded",
      )
      .map((event) => `${event.type}:${event.data?.check}`);

    expect(failed.failureCategory).toBe("validation_failed");
    expect(baseline.checks[0]?.tests).toMatchObject({ parsed: true, failed: 2 });
    expect(test).toMatchObject({ status: "failed", outcome: "unresolved" });
    expect(test.attribution).toEqual({
      newFailures: [],
      preExistingFailures: ["calculator.test.js::B"],
      fixedFailures: ["calculator.test.js::A"],
    });
    expect(checkSequence).toEqual([
      "baseline.check_recorded:test",
      "baseline.check_recorded:typecheck",
      "baseline.check_recorded:lint",
      "validation.check_recorded:targeted_test",
      "validation.check_recorded:test",
      "validation.check_recorded:typecheck",
      "validation.check_recorded:lint",
    ]);

    const diff = await reportArtifact(job.id, "diff");
    const stat = await reportArtifact(job.id, "diff_stat");
    expect(diff.content).not.toContain("validation/");
    expect(stat.content).not.toContain("validation/");
    expect(diff.metadata).toMatchObject({ filesChanged: 1, insertions: 1, deletions: 1 });
    expect(stat.metadata).toMatchObject({ filesChanged: 1, insertions: 1, deletions: 1 });
  });

  it("classifies a newly broken named test as a regression against a red baseline", async () => {
    const agent = editingAgent(async (tools, signal) => {
      const path = "/home/node/workspace/repo/calculator.js";
      const current = await tools.readFile(path, signal);
      await tools.writeFile(
        path,
        current.content.replace("protectedBehavior = true", "protectedBehavior = false"),
        signal,
      );
    });
    const running = startRealWorker("sandbox-m7-attribution-break", { agent });
    const job = await createFixtureJob("attribution");
    await enqueue(running.queue.queue, job.id);

    const failed = await waitForStatus(job.id, "failed", { timeoutMs: 45_000 });
    const validation = parseSerializedValidationReport(
      (await reportArtifact(job.id, "validation_report")).content,
    );
    const test = comparisonsByKind(validation.checks).test;

    expect(failed.failureCategory).toBe("validation_failed");
    expect(validation.outcome).toBe("regressed");
    expect(test.outcome).toBe("regressed");
    expect(test.attribution).toEqual({
      newFailures: ["calculator.test.js::C"],
      preExistingFailures: ["calculator.test.js::A", "calculator.test.js::B"],
      fixedFailures: [],
    });
  });

  it("fails a present invalid rivet.json terminally without retrying", async () => {
    const running = startRealWorker("sandbox-m7-invalid-config");
    const job = await createFixtureJob("invalid-config");
    await enqueue(running.queue.queue, job.id);

    const failed = await waitForStatus(job.id, "failed", { timeoutMs: 45_000 });

    expect(failed.failureCategory).toBe("validation_config_invalid");
    expect((await readJob(job.id)).attemptCount).toBe(1);
    expect(await listArtifacts(job.id)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "baseline_report" })]),
    );
  });
});
