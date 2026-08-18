import { approvingReview, FakeCodingAgent, type ScriptedSession } from "@rivet/agent";
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
  type Sandbox,
  type SandboxProvider,
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
  options: {
    agent?: AgentOptions;
    artifactMaxBytes?: number;
    sandboxProvider?: SandboxProvider;
  } = {},
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
  const provider =
    options.sandboxProvider ??
    new DockerSandboxProvider({
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

/**
 * Observes the real container at the two sides of the read-only review.
 *
 * The production context does not expose its sandbox handle to the reviewer,
 * so this wrapper records the staged diff when validation captures it and
 * compares it again immediately before the processor destroys the container.
 * A reviewer with an accidental write capability would make these bytes differ.
 */
class ReviewDiffProbe implements SandboxProvider {
  before: string | undefined;
  after: string | undefined;

  constructor(private readonly delegate: SandboxProvider) {}

  async create(...args: Parameters<SandboxProvider["create"]>): Promise<Sandbox> {
    const sandbox = await this.delegate.create(...args);
    let destroyed = false;

    return {
      id: sandbox.id,
      exec: async (request) => {
        const result = await sandbox.exec(request);
        if (isValidationDiff(request.argv) && this.before === undefined) {
          this.before = result.stdout;
        }
        return result;
      },
      getFile: (path, options, signal) => sandbox.getFile(path, options, signal),
      putFile: (path, content, signal) => sandbox.putFile(path, content, signal),
      putArchive: (path, archive, signal) => sandbox.putArchive(path, archive, signal),
      destroy: async () => {
        if (destroyed) return;
        destroyed = true;
        if (this.before !== undefined) {
          const result = await sandbox.exec({
            argv: ["git", "diff", "--cached"],
            cwd: "/home/node/workspace/repo",
            timeoutMs: 10_000,
            signal: new AbortController().signal,
            maxOutputBytes: 262_144,
          });
          this.after = result.stdout;
        }
        await sandbox.destroy();
      },
    };
  }

  reap(jobIsLive: Parameters<SandboxProvider["reap"]>[0]): ReturnType<SandboxProvider["reap"]> {
    return this.delegate.reap(jobIsLive);
  }
}

function isValidationDiff(argv: readonly string[]): boolean {
  return argv.length === 3 && argv[0] === "git" && argv[1] === "diff" && argv[2] === "--cached";
}

async function createFixtureJob(variant: FixtureVariant, branch = "main") {
  return createJob({
    title: `${variant} sandbox fixture`,
    description: "Run the Milestone 2 pipeline against a hermetic repository.",
    repoUrl: fixture.url(variant),
    baseBranch: branch,
    reviewMode: "independent",
    maxReviewLoops: 2,
  });
}

function editingAgent(
  edit: (tools: ImplementerAgentToolbox, signal: AbortSignal) => Promise<void>,
  reviewerScript?: ScriptedSession,
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
      ...(reviewerScript === undefined ? {} : { reviewerScript }),
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

function reviewingEditingAgent(): AgentOptions {
  return editingAgent(
    async (tools, signal) => {
      await tools.writeFile(
        "/home/node/workspace/repo/acceptance-change.js",
        "export const acceptanceChange = true;\n",
        signal,
      );
    },
    {
      events: [
        {
          type: "session_started",
          sessionId: "sandbox-review-session",
          model: "fixture-model",
          provider: "fixture-provider",
          toolNames: ["list_files", "read", "search_text", "submit_review"],
        },
      ],
      review: approvingReview(),
    },
  );
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

    const resourceArtifact = (await listArtifacts(job.id)).find(
      (artifact) => artifact.type === "resource_report",
    );
    expect(resourceArtifact).toBeDefined();
    const resourceBody = resourceArtifact ? await getArtifact(job.id, resourceArtifact.id) : null;
    expect(resourceBody?.content).toContain('"memory"');
    const resourceEvent = events.find((event) => event.type === "sandbox.resources_recorded");
    expect(resourceEvent?.data).toMatchObject({
      artifactId: resourceArtifact?.id,
      artifactType: "resource_report",
      memoryLimitBytes: 512 * 1_024 * 1_024,
      oomKilled: false,
    });

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

  it("runs an independent reviewer with read-only tools and preserves the diff byte-for-byte", async () => {
    const probe = new ReviewDiffProbe(
      new DockerSandboxProvider({
        workerId: `sandbox-review-probe-${process.pid}`,
        reapGraceMs: 0,
      }),
    );
    const running = startRealWorker("sandbox-m8-review", {
      agent: reviewingEditingAgent(),
      sandboxProvider: probe,
    });
    const job = await createFixtureJob("green");
    await enqueue(running.queue.queue, job.id);

    await waitForStatus(job.id, "completed", { timeoutMs: 45_000 });
    const events = await listEvents(job.id, { limit: 500 });
    const reviewerStarted = events.find(
      (event) => event.type === "agent.session_started" && event.data?.agentRole === "reviewer",
    );

    expect(reviewerStarted?.data?.toolNames).toEqual([
      "list_files",
      "read",
      "search_text",
      "submit_review",
    ]);
    expect(events.some((event) => event.type === "review.recorded")).toBe(true);
    expect(probe.before).toBeDefined();
    expect(probe.after).toBe(probe.before);
    expect(probe.after).toContain("acceptance-change.js");
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
