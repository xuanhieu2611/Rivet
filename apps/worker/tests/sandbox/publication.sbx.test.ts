import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { approvingReview, FakeCodingAgent, type ScriptedSession } from "@rivet/agent";
import type { Repository } from "@rivet/contracts";
import {
  buildPipeline,
  createJob,
  listCommands,
  listEvents,
  type GitHubPipelineOptions,
  type ImplementerAgentToolbox,
  type Sandbox,
  type SandboxProvider,
  type SandboxSpec,
} from "@rivet/core";
import { db, jobs } from "@rivet/database";
import { FakeGitHubClient } from "@rivet/github";
import { DockerSandboxProvider } from "@rivet/sandbox";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_IMAGE } from "../../src/config";
import { publish, seedClone, type HostGitCommand } from "../../src/git";
import {
  closeConnections,
  createTestQueue,
  enqueue,
  resetDatabase,
  startTestWorker,
  TEST_CONFIG,
  type TestQueue,
  type TestWorker,
  waitForStatus,
} from "../integration/support";

/**
 * Acceptance run H: a private repository, seeded from the host into a real
 * container.
 *
 * This is the run that proves the invariant AGENTS.md states - the container
 * never sees a credential - and it is the one to re-run first whenever
 * provisioning changes. The token is a distinctive sentinel, so "contains no
 * token" is a single grep across the container's environment, its
 * `.git/config`, every command row, every event row and every host Git command
 * that could have reached a log line.
 *
 * The remote here is a bare repository on a host path rather than the git
 * daemon the other sandbox cases use, because the seeded path clones on the
 * **host**. Nothing inside the container ever reaches the remote at all, which
 * is the property under test.
 */

const runFile = promisify(execFile);

const INSTALLATION_ID = 5_150;
const REPO_OWNER = "rivet-test";
const REPO_NAME = "seeded-fixture";
const SENTINEL_TOKEN = "ghs-rivet-sentinel-container-must-never-see-1234567890";
const WORKDIR = process.env.SANDBOX_WORKDIR ?? "/home/node/workspace";
const REPO_DIR = `${WORKDIR}/repo`;

const USAGE = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
} as const;

const PRIVATE_REPOSITORY: Repository = {
  id: 5_151,
  owner: REPO_OWNER,
  name: REPO_NAME,
  private: true,
  defaultBranch: "main",
};

interface SeedFixture {
  root: string;
  remote: string;
  baseCommitSha: string;
  binarySha256: string;
  binaryBytes: number;
  destroy: () => Promise<void>;
}

let fixture: SeedFixture | undefined;
let queue: TestQueue | undefined;
let worker: TestWorker | undefined;

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
  await fixture?.destroy();
  await closeConnections();
});

describe("Milestone 9 seeded provisioning", () => {
  it("H: seeds a private repository into a container that holds no credential", async () => {
    fixture = await createSeedFixture();
    const client = new FakeGitHubClient({
      repositories: [PRIVATE_REPOSITORY],
      tokenValue: SENTINEL_TOKEN,
    });
    const hostCommands: HostGitCommand[] = [];
    const probe = new SeededSandboxProbe(dockerProvider());

    const job = await createSeededJob(fixture);
    startSeededWorker({ client, probe, hostCommands, seedMaxBytes: 64 * 1_024 * 1_024 });
    await enqueue(queue!.queue, job.id, job.dispatchGeneration);
    const finished = await waitForStatus(job.id, ["completed", "failed"], { timeoutMs: 300_000 });

    expect(finished.failureReason ?? "").not.toContain(SENTINEL_TOKEN);
    expect(finished.status).toBe("completed");
    expect(finished.baseCommitSha).toBe(fixture.baseCommitSha);

    // The repository the container actually received.
    expect(probe.observations.status).toBe("");
    expect(probe.observations.head).toBe(fixture.baseCommitSha);
    expect(probe.observations.subject).toBe("Create the seeded fixture");
    expect(probe.observations.remotes).toBe("");
    expect(probe.observations.binarySha256).toBe(fixture.binarySha256);
    expect(probe.observations.binaryBytes).toBe(String(fixture.binaryBytes));

    // The four no-token-anywhere assertions, plus the container's own config.
    expect(JSON.stringify(probe.specs)).not.toContain(SENTINEL_TOKEN);
    expect(JSON.stringify(probe.specs)).not.toContain("OPENROUTER_API_KEY");
    expect(probe.observations.gitConfig).not.toContain(SENTINEL_TOKEN);
    expect(probe.observations.gitConfig).not.toContain("http.extraheader");

    const commands = await listCommands(job.id, { limit: 500 });
    expect(JSON.stringify(commands)).not.toContain(SENTINEL_TOKEN);
    const events = await listEvents(job.id, { limit: 1_000 });
    expect(JSON.stringify(events)).not.toContain(SENTINEL_TOKEN);
    // Everything a host Git command could have put in a log line. The logger's
    // own redaction pass is unit-tested in `logger.test.ts`; this asserts the
    // argv never carried the token in the first place, which is the boundary
    // that matters when redaction is a safety net rather than a fence.
    expect(hostCommands.length).toBeGreaterThan(0);
    expect(JSON.stringify(hostCommands)).not.toContain(SENTINEL_TOKEN);

    // The publication itself, which shares the same host clone discipline.
    const branch = finished.finalBranch ?? "";
    expect(branch).toMatch(/^rivet\/job-/u);
    expect(await gitRemote(fixture, ["rev-parse", `${branch}^`])).toBe(fixture.baseCommitSha);
    // The binary file survived the host clone, the archive, the container, the
    // capture, the host apply and the push without changing a byte.
    await expect(remoteBlobSha256(fixture, `${branch}:binary.dat`)).resolves.toBe(
      fixture.binarySha256,
    );
  }, 300_000);

  it("H: refuses a seed archive above its bound before creating a container", async () => {
    fixture ??= await createSeedFixture();
    const client = new FakeGitHubClient({
      repositories: [PRIVATE_REPOSITORY],
      tokenValue: SENTINEL_TOKEN,
    });
    const probe = new SeededSandboxProbe(dockerProvider());

    const job = await createSeededJob(fixture);
    // Below the fixture's own binary file, so the bound is reached by the
    // archive rather than by an accident of packaging.
    startSeededWorker({ client, probe, hostCommands: [], seedMaxBytes: 4_096 });
    await enqueue(queue!.queue, job.id, job.dispatchGeneration);
    const finished = await waitForStatus(job.id, ["completed", "failed"], { timeoutMs: 120_000 });

    expect(finished.status).toBe("failed");
    expect(finished.failureCategory).toBe("repo_unavailable");
    expect(finished.failureReason).toContain("4096");
    // A stated failure, and it happens before there is a container to explain.
    expect(probe.specs).toHaveLength(0);
    expect(finished.sandboxId).toBeNull();
  }, 120_000);
});

/**
 * Watches the one container this run creates, from both sides.
 *
 * The production phase context does not hand its sandbox to a test, so the
 * probe records every spec on the way in and asks the container what it holds
 * the moment the seed lands.
 */
class SeededSandboxProbe implements SandboxProvider {
  readonly specs: SandboxSpec[] = [];
  readonly observations: Record<string, string> = {};

  constructor(private readonly delegate: SandboxProvider) {}

  async create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
    this.specs.push(spec);
    const sandbox = await this.delegate.create(spec, signal);

    return {
      id: sandbox.id,
      exec: (request) => sandbox.exec(request),
      getFile: (path, options, fileSignal) => sandbox.getFile(path, options, fileSignal),
      putFile: (path, content, fileSignal) => sandbox.putFile(path, content, fileSignal),
      putArchive: async (path, archive, archiveSignal) => {
        await sandbox.putArchive(path, archive, archiveSignal);
        // The seeded repository is read here rather than at destroy, because
        // this is the only moment it is exactly what the host delivered:
        // installing dependencies and running a session both change the tree,
        // and "clean at the base commit" is a claim about the handover.
        await this.observe(sandbox);
      },
      destroy: () => sandbox.destroy(),
    };
  }

  reap(jobIsLive: Parameters<SandboxProvider["reap"]>[0]): ReturnType<SandboxProvider["reap"]> {
    return this.delegate.reap(jobIsLive);
  }

  private async observe(sandbox: Sandbox): Promise<void> {
    const read = async (key: string, argv: string[]): Promise<void> => {
      const result = await sandbox.exec({
        argv,
        cwd: REPO_DIR,
        timeoutMs: 15_000,
        signal: new AbortController().signal,
        maxOutputBytes: 262_144,
      });
      this.observations[key] = result.stdout.trim();
    };

    await read("status", ["git", "status", "--porcelain"]);
    await read("head", ["git", "rev-parse", "HEAD"]);
    await read("subject", ["git", "log", "-1", "--format=%s"]);
    await read("remotes", ["git", "remote"]);
    await read("gitConfig", ["cat", ".git/config"]);
    await read("binarySha256", ["sh", "-c", "sha256sum binary.dat | cut -d' ' -f1"]);
    await read("binaryBytes", ["sh", "-c", "wc -c < binary.dat"]);
  }
}

interface SeededWorkerInput {
  client: FakeGitHubClient;
  probe: SeededSandboxProbe;
  hostCommands: HostGitCommand[];
  seedMaxBytes: number;
}

function startSeededWorker(input: SeededWorkerInput): void {
  const sandboxConfig = {
    mode: "docker" as const,
    image: process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
    workdir: WORKDIR,
    memoryBytes: 512 * 1_024 * 1_024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 128,
    commandTimeoutMs: 10_000,
    cloneTimeoutMs: 30_000,
    installTimeoutMs: 60_000,
    baselineTimeoutMs: 30_000,
    checkTimeoutMs: 30_000,
    diffMaxBytes: 262_144,
    validationReportMaxBytes: 1_048_576,
    targetedMaxFiles: 25,
    maxOutputBytes: 16_384,
    reapGraceMs: 0,
  };

  const observer = { onCommand: (command: HostGitCommand) => input.hostCommands.push(command) };
  const github: GitHubPipelineOptions = {
    client: input.client,
    seedClone: (request) => seedClone({ ...request, observer }),
    publish: (request) => publish({ ...request, observer }),
    seedMaxBytes: input.seedMaxBytes,
    cloneTimeoutMs: 60_000,
    pushTimeoutMs: 60_000,
  };

  const phases = buildPipeline({
    sandbox: input.probe,
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
    appBaseUrl: "https://rivet.test",
    agent: {
      sessionTimeoutMs: 60_000,
      maxTurns: 4,
      previewMaxBytes: 512,
      fileMaxBytes: 16_384,
      coding: editingAgent(),
    },
    github,
  });

  const testQueue = createTestQueue("publication-sbx", { attempts: 1 });
  worker = startTestWorker({
    queue: testQueue.queue,
    config: { ...TEST_CONFIG, pipelineSpeed: 0, sandbox: sandboxConfig },
    phases,
  });
  queue = testQueue;
}

/** One turn that edits a tracked file, so the run has something to publish. */
function editingAgent(): FakeCodingAgent {
  const session: ScriptedSession = {
    events: [
      {
        type: "session_started",
        sessionId: "seeded-implementation",
        model: "fixture-model",
        provider: "fixture-provider",
        toolNames: ["bash", "edit", "read", "write"],
      },
      { type: "turn_started", turn: 0 },
      { type: "assistant_message", turn: 0, text: "Raised the sum." },
      { type: "turn_completed", turn: 0 },
      { type: "session_ended", reason: "completed", turns: 1, usage: USAGE },
    ],
    useTools: async (tools: ImplementerAgentToolbox, signal: AbortSignal) => {
      await tools.writeFile(`${REPO_DIR}/src/sum.js`, "module.exports.sum = 1;\n", signal);
    },
  };

  return new FakeCodingAgent({
    script: [session],
    reviewerScript: { review: approvingReview() },
  });
}

async function createSeededJob(seed: SeedFixture) {
  const job = await createJob({
    title: "Seed a private repository",
    description: "Run the Milestone 9 seeded provisioning path against a real container.",
    repoUrl: "https://github.com/rivet-test/seeded-fixture",
    baseBranch: "main",
    reviewMode: "independent",
    maxReviewLoops: 2,
  });
  // `createJobSchema` requires an https URL and this remote is a directory, so
  // the binding lands on the row the pipeline actually reads.
  await db
    .update(jobs)
    .set({
      repoUrl: seed.remote,
      githubInstallationId: INSTALLATION_ID,
      repoOwner: REPO_OWNER,
      repoName: REPO_NAME,
    })
    .where(eq(jobs.id, job.id));
  return job;
}

/** A bare repository with a binary file, on a host path the container cannot see. */
async function createSeedFixture(): Promise<SeedFixture> {
  const root = await mkdtemp(join(tmpdir(), "rivet-seed-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const binary = randomBytes(64 * 1_024);

  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "binary.dat"), binary);
  await writeFile(join(source, "src", "sum.js"), "module.exports.sum = 0;\n");
  await writeFile(join(source, "test.js"), 'console.log("seeded fixture passed");\n');
  await writeFile(join(source, "typecheck.js"), 'console.log("seeded typecheck passed");\n');
  await writeFile(join(source, "lint.js"), 'console.log("seeded lint passed");\n');
  await writeFile(
    join(source, ".npmrc"),
    "registry=http://127.0.0.1:9/\naudit=false\nfund=false\n",
  );
  await writeFile(
    join(source, "package.json"),
    `${JSON.stringify(
      {
        name: "rivet-seeded-fixture",
        version: "1.0.0",
        private: true,
        scripts: {
          test: "node test.js",
          typecheck: "node typecheck.js",
          lint: "node lint.js",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(source, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "rivet-seeded-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "rivet-seeded-fixture", version: "1.0.0" } },
      },
      null,
      2,
    )}\n`,
  );

  await git(["init", "-b", "main", source]);
  await git(["-C", source, "config", "user.name", "Seed Fixture"]);
  await git(["-C", source, "config", "user.email", "seed@example.test"]);
  await git(["-C", source, "add", "-A"]);
  await git(["-C", source, "commit", "--message", "Create the seeded fixture"]);
  const baseCommitSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
  await git(["clone", "--bare", source, remote]);

  return {
    root,
    remote,
    baseCommitSha,
    binarySha256: createHash("sha256").update(binary).digest("hex"),
    binaryBytes: binary.byteLength,
    destroy: () => rm(root, { recursive: true, force: true }),
  };
}

/** The bytes of a blob on the remote, hashed the way the fixture hashed them. */
async function remoteBlobSha256(seed: SeedFixture, revision: string): Promise<string> {
  const { stdout } = await runFile("git", ["-C", seed.remote, "cat-file", "blob", revision], {
    encoding: "buffer",
    maxBuffer: 16 * 1_024 * 1_024,
  });
  return createHash("sha256").update(stdout).digest("hex");
}

function dockerProvider(): SandboxProvider {
  return new DockerSandboxProvider({
    workerId: `sandbox-publication-${process.pid}`,
    reapGraceMs: 0,
  });
}

async function gitRemote(seed: SeedFixture, argv: string[]): Promise<string> {
  return (await git(["-C", seed.remote, ...argv])).trim();
}

async function git(argv: string[]): Promise<string> {
  const { stdout } = await runFile("git", argv, {
    encoding: "utf8",
    maxBuffer: 16 * 1_024 * 1_024,
  });
  return stdout;
}
