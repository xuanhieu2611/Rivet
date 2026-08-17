import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { approvingReview, FakeCodingAgent, type ScriptedSession } from "@rivet/agent";
import {
  buildBenchmarkFixtures,
  buildPipeline,
  createJob,
  listEvents,
  type BuiltBenchmarkCase,
  type ImplementerAgentToolbox,
  type LocalSeedPipelineOptions,
  type Sandbox,
  type SandboxProvider,
  type SandboxSpec,
} from "@rivet/core";
import { db, jobs } from "@rivet/database";
import { DockerSandboxProvider } from "@rivet/sandbox";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_IMAGE } from "../../src/config";
import { createLocalSeedOptions } from "../../src/eval";
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
import { serveBareRepositories, type GitDaemon } from "./fixtures/git-daemon";

/**
 * Acceptance run B: a job seeded from `rivet-local:<case-id>`.
 *
 * The claim under test is a negative one - **the seed source must not invent a
 * working tree**. A harness whose fixtures arrive subtly different from the
 * files a person reviewed in `benchmarks/` measures something nobody authored,
 * and the difference would be invisible: an extra AppleDouble sidecar, a
 * changed mode, a dirty `git status`, a second commit. So the container's tree
 * is compared against the built repository's own `ls-tree` - modes, object ids
 * and paths in one string - and the binary file is compared byte for byte.
 *
 * The second half of the run is the architectural assertion of the milestone:
 * the event timeline of a job seeded from a local fixture and the timeline of
 * the same work against an ordinary remote are **equal**. If they are not, the
 * harness is measuring a different system than production runs.
 *
 * The comparison job clones over `git://` rather than `https://` because the
 * sandbox suite reaches no network; what matters is that it takes the ordinary
 * unauthenticated in-container clone path, which it does.
 */

const runFile = promisify(execFile);
const CASE_ID = "fixture-pass";
const WORKDIR = process.env.SANDBOX_WORKDIR ?? "/home/node/workspace";
const REPO_DIR = `${WORKDIR}/repo`;
const BENCHMARK_ROOT = resolve(import.meta.dirname, "../fixtures/benchmarks");

const USAGE = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
} as const;

interface BenchmarkFixture {
  root: string;
  fixtureRoot: string;
  built: BuiltBenchmarkCase;
  daemon: GitDaemon;
  lsTree: string;
  markerSha256: string;
  markerBytes: number;
  destroy: () => Promise<void>;
}

let fixture: BenchmarkFixture | undefined;
let queue: TestQueue | undefined;
let worker: TestWorker | undefined;

beforeAll(async () => {
  fixture = await createBenchmarkFixture();
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
  await fixture?.destroy();
  await closeConnections();
});

describe("Milestone 10 local benchmark provisioning", () => {
  it("B: seeds a container whose tree is the case's tree, byte for byte", async () => {
    const seed = fixture!;
    const probe = new SeededSandboxProbe(dockerProvider());

    const job = await createBenchmarkJob(`rivet-local:${CASE_ID}`);
    startBenchmarkWorker({ probe, localSeed: localSeedOptions(seed.fixtureRoot) });
    await enqueue(queue!.queue, job.id, job.dispatchGeneration);
    const finished = await waitForStatus(job.id, ["completed", "failed"], { timeoutMs: 300_000 });

    expect(finished.failureReason ?? "").toBe("");
    expect(finished.status).toBe("completed");
    // The commit is the one `case.lock.json` pins, which is what makes a result
    // reproducible rather than merely repeatable.
    expect(finished.baseCommitSha).toBe(seed.built.baseCommitSha);

    // Nothing was added, removed or modified on the way in.
    expect(probe.observations.status).toBe("");
    expect(probe.observations.head).toBe(seed.built.baseCommitSha);
    expect(probe.observations.commitCount).toBe("1");
    expect(probe.observations.subject).toBe("Benchmark seed");
    // Paths, modes and object ids, in one comparison against the repository the
    // fixture builder produced.
    expect(probe.observations.lsTree).toBe(seed.lsTree);
    // The two macOS tar flags, asserted from the other side of the boundary.
    expect(probe.observations.appleDouble).toBe("");
    expect(probe.observations.markerSha256).toBe(seed.markerSha256);
    expect(probe.observations.markerBytes).toBe(String(seed.markerBytes));

    // A local fixture has no remote and no credential of any kind, and neither
    // does the container it produced.
    expect(probe.observations.remotes).toBe("");
    expect(probe.observations.gitConfig).not.toContain(seed.fixtureRoot);
    expect(probe.observations.gitConfig).not.toContain("http.extraheader");
    expect(JSON.stringify(probe.specs)).not.toContain("OPENROUTER_API_KEY");
    expect(probe.specs.every((spec) => Object.keys(spec.env).length === 0)).toBe(true);
  }, 300_000);

  it("B: produces the same timeline as the same work against an ordinary remote", async () => {
    const seed = fixture!;

    const local = await createBenchmarkJob(`rivet-local:${CASE_ID}`);
    startBenchmarkWorker({ localSeed: localSeedOptions(seed.fixtureRoot) });
    await enqueue(queue!.queue, local.id, local.dispatchGeneration);
    await waitForStatus(local.id, ["completed", "failed"], { timeoutMs: 300_000 });

    await worker?.close();
    await queue?.destroy();
    const remote = await createBenchmarkJob(seed.daemon.url(CASE_ID));
    startBenchmarkWorker({});
    await enqueue(queue!.queue, remote.id, remote.dispatchGeneration);
    await waitForStatus(remote.id, ["completed", "failed"], { timeoutMs: 300_000 });

    const localEvents = await projectedTypes(local.id);
    const remoteEvents = await projectedTypes(remote.id);

    expect(localEvents).toEqual(remoteEvents);
    // Stated separately so a run where both jobs failed identically cannot pass
    // this case by being equally broken.
    expect(localEvents.at(-1)).toBe("job.completed");
    expect(localEvents).toContain("run.summarized");

    // The one difference the projection sets aside, asserted rather than
    // assumed: a seeded job uploads an archive where a cloning job runs
    // `git clone`, so it records exactly one command fewer. Everything else
    // about the two transcripts is the same length.
    expect(await commandEventCount(local.id)).toBe((await commandEventCount(remote.id)) - 2);
  }, 600_000);

  it("B: refuses a local repository when the harness is off", async () => {
    const probe = new SeededSandboxProbe(dockerProvider());

    const job = await createBenchmarkJob(`rivet-local:${CASE_ID}`);
    // No `localSeed` in the pipeline, which is what `RIVET_EVAL=off` produces.
    startBenchmarkWorker({ probe });
    await enqueue(queue!.queue, job.id, job.dispatchGeneration);
    const finished = await waitForStatus(job.id, ["completed", "failed"], { timeoutMs: 120_000 });

    expect(finished.status).toBe("failed");
    expect(finished.failureCategory).toBe("repo_unavailable");
    expect(finished.failureReason).toContain("RIVET_EVAL=on");
    // Refused before there is a container to explain, like every other seed
    // failure on this path.
    expect(probe.specs).toHaveLength(0);
    expect(finished.sandboxId).toBeNull();
  }, 120_000);
});

/** The production assembly, pointed at the suite's own fixture root. */
function localSeedOptions(fixtureRoot: string): LocalSeedPipelineOptions {
  const options = createLocalSeedOptions(
    {
      mode: "on",
      benchmarkRoot: BENCHMARK_ROOT,
      fixtureRoot,
      cloneTimeoutMs: 60_000,
      seedMaxBytes: 64 * 1_024 * 1_024,
    },
    { repositoryRoot: fixtureRoot },
  );
  if (!options) throw new Error("RIVET_EVAL=on must produce a local seed source.");
  return options;
}

/**
 * Watches the one container this run creates, from both sides.
 *
 * The same device run H of the M9 contract uses: the production phase context
 * does not hand its sandbox to a test, so the probe records every spec on the
 * way in and asks the container what it holds the moment the seed lands - the
 * only moment the tree is exactly what the host delivered.
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
    await read("commitCount", ["git", "rev-list", "--count", "HEAD"]);
    await read("subject", ["git", "log", "-1", "--format=%s"]);
    await read("lsTree", ["git", "ls-tree", "-r", "HEAD"]);
    await read("remotes", ["git", "remote"]);
    await read("gitConfig", ["cat", ".git/config"]);
    await read("appleDouble", [
      "sh",
      "-c",
      "find . -path ./.git -prune -o -name '._*' -print | sort",
    ]);
    await read("markerSha256", ["sh", "-c", "sha256sum assets/marker.bin | cut -d' ' -f1"]);
    await read("markerBytes", ["sh", "-c", "wc -c < assets/marker.bin"]);
  }
}

interface BenchmarkWorkerInput {
  probe?: SeededSandboxProbe;
  localSeed?: LocalSeedPipelineOptions;
}

function startBenchmarkWorker(input: BenchmarkWorkerInput): void {
  const sandboxConfig = {
    mode: "docker" as const,
    image: process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
    workdir: WORKDIR,
    memoryBytes: 512 * 1_024 * 1_024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 128,
    commandTimeoutMs: 15_000,
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

  const phases = buildPipeline({
    sandbox: input.probe ?? dockerProvider(),
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
    agent: {
      sessionTimeoutMs: 60_000,
      maxTurns: 4,
      previewMaxBytes: 512,
      fileMaxBytes: 16_384,
      coding: fixingAgent(),
    },
    ...(input.localSeed ? { localSeed: input.localSeed } : {}),
  });

  const testQueue = createTestQueue("local-seed-sbx", { attempts: 1 });
  worker = startTestWorker({
    queue: testQueue.queue,
    config: { ...TEST_CONFIG, pipelineSpeed: 0, sandbox: sandboxConfig },
    phases,
  });
  queue = testQueue;
}

function dockerProvider(): SandboxProvider {
  return new DockerSandboxProvider({
    workerId: `local-seed-sbx-${process.pid}`,
    reapGraceMs: 0,
  });
}

/** One turn that closes the boundary the case's hidden tests check. */
function fixingAgent(): FakeCodingAgent {
  const session: ScriptedSession = {
    events: [
      {
        type: "session_started",
        sessionId: "local-seed-implementation",
        model: "fixture-model",
        provider: "fixture-provider",
        toolNames: ["bash", "edit", "read", "write"],
      },
      { type: "turn_started", turn: 0 },
      { type: "assistant_message", turn: 0, text: "Included the threshold weight." },
      { type: "turn_completed", turn: 0 },
      { type: "session_ended", reason: "completed", turns: 1, usage: USAGE },
    ],
    useTools: async (tools: ImplementerAgentToolbox, signal: AbortSignal) => {
      await tools.writeFile(
        `${REPO_DIR}/src/shipping.js`,
        [
          "export const HEAVY_PARCEL_KG = 5;",
          "export const LIGHT_RATE = 5;",
          "export const HEAVY_RATE = 12;",
          "",
          "export function shippingCost(weightKg) {",
          '  if (typeof weightKg !== "number" || !Number.isFinite(weightKg) || weightKg < 0) {',
          '    throw new TypeError("weightKg must be a non-negative finite number");',
          "  }",
          "",
          "  return weightKg >= HEAVY_PARCEL_KG ? HEAVY_RATE : LIGHT_RATE;",
          "}",
          "",
        ].join("\n"),
        signal,
      );
    },
  };

  return new FakeCodingAgent({
    script: [session],
    reviewerScript: { review: approvingReview() },
  });
}

async function createBenchmarkJob(repoUrl: string) {
  const job = await createJob({
    title: "Fix the shipping weight boundary",
    description: "Run the Milestone 10 local seed path against a real container.",
    // `createJobSchema` is https-only and stays that way, so the local scheme
    // lands on the row rather than passing through the browser-facing schema.
    // That refusal is asserted in `packages/contracts`.
    repoUrl: "https://example.com/rivet/benchmark-placeholder",
    baseBranch: "main",
    reviewMode: "independent",
    maxReviewLoops: 2,
  });
  await db.update(jobs).set({ repoUrl }).where(eq(jobs.id, job.id));
  return job;
}

/**
 * The timeline, as the M8 and M9 contracts read one.
 *
 * Command lifecycle rows are a transcript rather than a milestone, and they are
 * the one place the two jobs are legitimately allowed to differ: seeding
 * uploads an archive where cloning runs `git clone`, so the cloning job records
 * one extra command. Every event that says what the *job* did is compared, in
 * order, with nothing set aside.
 */
async function projectedTypes(jobId: string): Promise<string[]> {
  const events = await listEvents(jobId, { limit: 1_000 });
  return events
    .map((event) => event.type)
    .filter((type) => type !== "command.started" && type !== "command.completed");
}

async function commandEventCount(jobId: string): Promise<number> {
  const events = await listEvents(jobId, { limit: 1_000 });
  return events.filter(
    (event) => event.type === "command.started" || event.type === "command.completed",
  ).length;
}

/**
 * Builds the suite-owned case and serves the result two ways.
 *
 * `lockfileMode: "verify"` is deliberate: it asserts that the case on disk
 * still builds to the commit its `case.lock.json` pins, which is run A's
 * assertion applied to the fixtures the rest of this run depends on.
 */
async function createBenchmarkFixture(): Promise<BenchmarkFixture> {
  const root = await mkdtemp(join(tmpdir(), "rivet-benchmark-fixture-"));
  const fixtureRoot = join(root, "built");
  const [built] = await buildBenchmarkFixtures({
    benchmarkRoot: BENCHMARK_ROOT,
    outputRoot: fixtureRoot,
    lockfileMode: "verify",
  }).then((cases) => cases.filter((entry) => entry.id === CASE_ID));
  if (!built) throw new Error(`The ${CASE_ID} benchmark case did not build.`);

  const lsTree = (
    await runGit(["git", "-C", built.bareRepository, "ls-tree", "-r", built.baseCommitSha])
  ).stdout.trim();
  const markerPath = join(BENCHMARK_ROOT, CASE_ID, "repo", "assets", "marker.bin");
  const marker = await readFile(markerPath);
  const markerBytes = (await stat(markerPath)).size;
  const daemon = await serveBareRepositories(fixtureRoot);

  return {
    root,
    fixtureRoot,
    built,
    daemon,
    lsTree,
    markerSha256: createHash("sha256").update(marker).digest("hex"),
    markerBytes,
    destroy: async () => {
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runGit(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const [command, ...args] = argv;
  if (!command) throw new Error("Missing command");
  return runFile(command, args, { encoding: "utf8", maxBuffer: 16 * 1_024 * 1_024 });
}
