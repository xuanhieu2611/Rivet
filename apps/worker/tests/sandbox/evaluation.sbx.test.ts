import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { approvingReview, FakeCodingAgent, type ScriptedSession } from "@rivet/agent";
import { JOB_EVENT_TYPES, type JobEventType, type RunMetrics } from "@rivet/contracts";
import {
  buildBenchmarkFixtures,
  buildPipeline,
  captureWorkspacePatch,
  compressCheckpointPatch,
  createJob,
  decompressCheckpointPatch,
  getCheckpoint,
  getJob,
  getLatestCheckpoint,
  gradeEvaluationRun,
  listEvents,
  loadBenchmarkCases,
  loadHiddenTestFiles,
  readValidationReport,
  sha256CheckpointPatch,
  summarizeEvaluationRuns,
  type AggregatableEvaluationRun,
  type BuiltBenchmarkCase,
  type GradeEvaluationRunResult,
  type HiddenTestFile,
  type ImplementerAgentToolbox,
  type LocalSeedPipelineOptions,
  type Sandbox,
  type SandboxProvider,
  type SandboxSpec,
} from "@rivet/core";
import { db, jobArtifacts, jobCheckpoints, jobCommands, jobEvents, jobs } from "@rivet/database";
import { DockerSandboxProvider } from "@rivet/sandbox";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_IMAGE } from "../../src/config";
import { createLocalSeedOptions } from "../../src/eval";
import {
  closeConnections,
  createTestQueue,
  enqueue,
  resetDatabase,
  startTestWorker,
  TEST_CONFIG,
  waitForStatus,
  type TestQueue,
  type TestWorker,
} from "../integration/support";

/**
 * Acceptance runs C, D and F: the assertions that need real bytes.
 *
 * **Run C** is the one this milestone's credibility rests on. A hidden test the
 * model could read is not a hidden test, and the leak would be invisible in
 * every number the harness reports afterwards - so the case's sentinel string
 * is searched for across the whole container filesystem, every command
 * transcript, every event, every artifact and every checkpoint patch. Six of
 * those are cheap; the checkpoint is the one that matters most and is easiest
 * to get wrong, because the patch is gzip in Postgres and a naive grep over the
 * column finds nothing whether the sentinel is there or not. So the search
 * decompresses first, and a positive control - a sentinel deliberately planted
 * in the workspace, captured through the production capture path and searched
 * the same way - proves the search itself works. A negative assertion with no
 * positive control is not evidence.
 *
 * **Run D** is the grader discriminating. Two scripted diffs against the same
 * seed and the same case: one that satisfies the hidden rule and one that
 * satisfies only the public suite. The second is the run that justifies the
 * whole hidden-test design - the job completes, every check Rivet can run is
 * green, the reviewer approves, and it is wrong.
 *
 * **Run F** is grading refusing to grade. Three ways the workspace can fail to
 * be the job's workspace - a flipped byte, a patch that will not apply, and a
 * seed from the wrong case - all landing on `ungraded` rather than `failed`,
 * with the job row and its timeline untouched. Grading a tree the job did not
 * produce is worse than not grading, and a grading failure is the runner's
 * problem rather than a second opinion about a job that already finished.
 */

const runFile = promisify(execFile);
const SENTINEL = "RIVET_HIDDEN_SENTINEL_7f3c1a9e4b2d";
const CASE_ID = "fixture-partial";
const OTHER_CASE_ID = "fixture-pass";
const WORKDIR = process.env.SANDBOX_WORKDIR ?? "/home/node/workspace";
const REPO_DIR = `${WORKDIR}/repo`;
const BENCHMARK_ROOT = resolve(import.meta.dirname, "../fixtures/benchmarks");
const JOB_TIMEOUT_MS = 600_000;

const USAGE = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
} as const;

/** Everything one scripted job leaves behind, kept for the assertions below. */
interface CompletedRun {
  jobId: string;
  status: string;
  probe: SentinelProbe;
}

let fixtureRoot: string;
let temporaryRoot: string;
let built: Map<string, BuiltBenchmarkCase>;
let hiddenFiles: HiddenTestFile[];
let goodRun: CompletedRun;
let publicOnlyRun: CompletedRun;
let queue: TestQueue | undefined;
let worker: TestWorker | undefined;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "rivet-evaluation-sbx-"));
  fixtureRoot = join(temporaryRoot, "built");
  const cases = await buildBenchmarkFixtures({
    benchmarkRoot: BENCHMARK_ROOT,
    outputRoot: fixtureRoot,
    lockfileMode: "verify",
  });
  built = new Map(cases.map((entry) => [entry.id, entry]));

  const loaded = await loadBenchmarkCases(BENCHMARK_ROOT);
  const partial = loaded.find((entry) => entry.id === CASE_ID);
  if (!partial) throw new Error(`The ${CASE_ID} case did not load.`);
  hiddenFiles = [...(await loadHiddenTestFiles(partial.hiddenDirectory))];

  await resetDatabase();
  goodRun = await runScriptedJob("good", correctOrderTotal(), { plantSentinel: true });
  publicOnlyRun = await runScriptedJob("public-only", publicOnlyOrderTotal(), {
    writeDecoyHiddenTest: true,
  });
}, 1_800_000);

afterAll(async () => {
  await worker?.close();
  await queue?.destroy();
  await rm(temporaryRoot, { recursive: true, force: true });
  await closeConnections();
});

describe("Milestone 10 hidden tests and grading", () => {
  it("C: the sentinel is in no container, transcript, event, artifact or patch", async () => {
    // The container filesystem, whole, asked while the job's container still
    // existed. Everything else is read back from Postgres now.
    expect(goodRun.probe.observations.probeError).toBeUndefined();
    expect(publicOnlyRun.probe.observations.probeError).toBeUndefined();
    // The search proved it can find something before it is trusted to find
    // nothing.
    expect(goodRun.probe.observations.controlMatches).toContain("/src/order.js");
    expect(publicOnlyRun.probe.observations.controlMatches).toContain("/src/order.js");
    expect(goodRun.probe.observations.containerMatches).toBe("");
    expect(publicOnlyRun.probe.observations.containerMatches).toBe("");

    for (const jobId of [goodRun.jobId, publicOnlyRun.jobId]) {
      const commands = await db.select().from(jobCommands).where(eq(jobCommands.jobId, jobId));
      expect(commands.length).toBeGreaterThan(0);
      expect(JSON.stringify(commands)).not.toContain(SENTINEL);

      const events = await db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId));
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain(SENTINEL);

      const artifacts = await db.select().from(jobArtifacts).where(eq(jobArtifacts.jobId, jobId));
      expect(artifacts.length).toBeGreaterThan(0);
      expect(artifacts.map((artifact) => artifact.content).join("\n")).not.toContain(SENTINEL);

      // The gzip column, decompressed before it is searched. A grep over the
      // stored bytes would pass whether the sentinel were there or not.
      const patches = await readCheckpointPatches(jobId);
      expect(patches.length).toBeGreaterThan(0);
      expect(patches.join("\n")).not.toContain(SENTINEL);
    }
  });

  it("C: the same search finds a sentinel that was deliberately planted", () => {
    // The positive control, taken through the production capture path in the
    // job's own container: plant, capture, compress, decompress, search.
    expect(goodRun.probe.observations.plantedPatchContainsSentinel).toBe("yes");
  });

  it("C: the seeded repository holds no hidden path and the timeline stays M9's", async () => {
    const repository = built.get(CASE_ID)?.bareRepository;
    if (!repository) throw new Error("The case was not built.");
    const tree = await runGit([
      "git",
      "--git-dir",
      repository,
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
    ]);
    expect(tree.stdout).not.toContain("hidden/");
    expect(tree.stdout).toContain("src/order.js");

    // "M10 adds no job event type" stops being a sentence in a plan: an
    // evaluation job's timeline draws from the same vocabulary an ordinary
    // job's does, and none of it mentions the harness.
    const vocabulary = new Set<string>(JOB_EVENT_TYPES);
    const types = (await listEvents(goodRun.jobId, { limit: 2_000 })).map((event) => event.type);
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(vocabulary.has(type)).toBe(true);
      expect(type).not.toMatch(/evaluation|benchmark|suite|grad/iu);
    }
    expect(new Set<JobEventType>(types).size).toBeGreaterThan(1);
  });

  it("D: grades the known-good diff as passed with a perfect score", async () => {
    const provider = new RecordingProvider(dockerProvider());
    const graded = await grade(goodRun.jobId, { provider });

    expect(graded.result).toBe("passed");
    expect(graded.score).toBe(1);
    expect(graded.failureCategory).toBeNull();
    expect(graded.failureLabelSource).toBeNull();
    expect(graded.hiddenTests?.total ?? 0).toBeGreaterThan(0);
    expect(graded.hiddenTests?.passed).toBe(graded.hiddenTests?.total);

    // The grading container ran on the image the job ran on, and it is gone.
    expect(provider.specs).toHaveLength(1);
    expect(provider.specs[0]?.image).toBe(sandboxImage());
    expect(provider.destroyed).toEqual([graded.sandboxId]);
  }, 600_000);

  it("D: grades the public-tests-only diff as failed, on a job that completed", async () => {
    const provider = new RecordingProvider(dockerProvider());
    const graded = await grade(publicOnlyRun.jobId, { provider });

    // The point of the whole design: the job passed every check Rivet can run.
    expect(publicOnlyRun.status).toBe("completed");
    const report = await readValidationReport(publicOnlyRun.jobId);
    expect(report?.outcome).not.toBe("regressed");

    expect(graded.result).toBe("failed");
    expect(graded.score).toBeGreaterThan(0);
    expect(graded.score).toBeLessThan(1);
    // The session wrote its own file at a `hidden/` path. The case's version
    // wins, or a model could write its own benchmark and pass it.
    expect(graded.hiddenTests?.failed ?? 0).toBeGreaterThan(0);
    expect(provider.destroyed).toEqual([graded.sandboxId]);
  }, 600_000);

  it("D: destroys the grading container when a step throws", async () => {
    const provider = new RecordingProvider(dockerProvider(), {
      failPutFile: (path) => path.includes("/hidden/"),
    });
    const graded = await grade(goodRun.jobId, { provider });

    expect(graded.result).toBe("ungraded");
    expect(graded.failureCategory).toBe("grade_workspace_invalid");
    expect(provider.specs).toHaveLength(1);
    expect(provider.destroyed).toHaveLength(1);
  }, 600_000);

  it("F: a flipped byte in the stored patch is ungraded, and the job is untouched", async () => {
    const before = await jobFacts(goodRun.jobId);
    const provider = new RecordingProvider(dockerProvider());

    const graded = await withTamperedCheckpoint(goodRun.jobId, flipOneByte, () =>
      grade(goodRun.jobId, { provider }),
    );

    expect(graded.result).toBe("ungraded");
    expect(graded.score).toBeNull();
    expect(graded.failureCategory).toBe("grade_workspace_invalid");
    expect(graded.failureLabelSource).toBe("auto");
    // Refused before a container existed: the corrupt patch is caught when it
    // is read, which is the cheapest place to notice it.
    expect(provider.specs).toHaveLength(0);
    expect(provider.destroyed).toHaveLength(0);
    expect(await jobFacts(goodRun.jobId)).toEqual(before);
  }, 600_000);

  it("F: a patch that will not apply is ungraded, and its container is destroyed", async () => {
    const before = await jobFacts(goodRun.jobId);
    const provider = new RecordingProvider(dockerProvider());

    const graded = await withTamperedCheckpoint(goodRun.jobId, replaceWithUnappliablePatch, () =>
      grade(goodRun.jobId, { provider }),
    );

    expect(graded.result).toBe("ungraded");
    expect(graded.failureCategory).toBe("grade_workspace_invalid");
    expect(provider.specs).toHaveLength(1);
    expect(provider.destroyed).toHaveLength(1);
    expect(await jobFacts(goodRun.jobId)).toEqual(before);
  }, 600_000);

  it("F: a seed from the wrong case is ungraded, and never scored", async () => {
    // The variant that catches a grader pointed at another benchmark. A patch
    // cut against one case's base commit will often apply cleanly to another's,
    // and the difference would otherwise show up only as a mysteriously low
    // score - so the commit comparison refuses before anything is applied.
    const provider = new RecordingProvider(dockerProvider());
    const graded = await grade(goodRun.jobId, { provider, benchmarkId: OTHER_CASE_ID });

    expect(graded.result).toBe("ungraded");
    expect(graded.score).toBeNull();
    expect(graded.failureCategory).toBe("grade_workspace_invalid");
    expect(provider.specs).toHaveLength(0);

    // Excluded from the success-rate denominator, and reported rather than
    // hidden: averaging a harness failure into a task success rate is the one
    // thing this milestone must not do.
    const summary = summarizeEvaluationRuns([
      aggregatable({ result: "ungraded", score: null, failureCategory: "grade_workspace_invalid" }),
      aggregatable({ result: "passed", score: 1, failureCategory: null }),
    ]);
    expect(summary.overall.total).toBe(2);
    expect(summary.overall.ungraded).toBe(1);
    expect(summary.overall.graded).toBe(1);
    expect(summary.overall.successRate).toBe(1);
  }, 600_000);
});

/** Grades one finished job against the case, with the real Docker adapter. */
async function grade(
  jobId: string,
  options: { provider: SandboxProvider; benchmarkId?: string },
): Promise<GradeEvaluationRunResult> {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} is gone.`);
  const benchmarkId = options.benchmarkId ?? CASE_ID;
  const report = await readValidationReport(jobId);

  return gradeEvaluationRun({
    jobId,
    job: {
      status: job.status,
      failureCategory: job.failureCategory,
      failureReason: job.failureReason,
      reviewDecision: job.reviewDecision,
    },
    validationOutcome: report?.outcome ?? null,
    benchmark: {
      id: benchmarkId,
      repoUrl: `rivet-local:${benchmarkId}`,
      baseBranch: "main",
      setupCommand: null,
      validationCommand: ["node", "--test", "test/order.test.js", "hidden/order.hidden.test.js"],
      hiddenFiles,
    },
    readCheckpoint: () => getLatestCheckpoint(jobId, { maxBytes: TEST_CONFIG.checkpointMaxBytes }),
    seed: localSeedOptions().seed,
    seedTimeoutMs: 120_000,
    seedMaxBytes: 64 * 1_024 * 1_024,
    sandbox: {
      provider: options.provider,
      image: sandboxImage(),
      workdir: WORKDIR,
      memoryBytes: 512 * 1_024 * 1_024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 128,
      commandTimeoutMs: 60_000,
      validationTimeoutMs: 120_000,
      maxOutputBytes: 65_536,
      maxPatchBytes: TEST_CONFIG.checkpointMaxBytes,
    },
    signal: new AbortController().signal,
  });
}

/** The job facts a grading failure must leave exactly as it found them. */
async function jobFacts(jobId: string): Promise<{
  status: string;
  failureCategory: string | null;
  events: string;
}> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) throw new Error(`Job ${jobId} is gone.`);
  const events = await listEvents(jobId, { limit: 2_000 });
  return {
    status: row.status,
    failureCategory: row.failureCategory,
    events: events.map((event) => `${event.id}:${event.type}`).join(","),
  };
}

/** Applies a checkpoint mutation, runs the body, and always puts the row back. */
async function withTamperedCheckpoint<T>(
  jobId: string,
  tamper: (patch: Buffer) => Buffer,
  body: () => Promise<T>,
): Promise<T> {
  const rows = await db.select().from(jobCheckpoints).where(eq(jobCheckpoints.jobId, jobId));
  const row = rows.sort((left, right) => right.sequence - left.sequence)[0];
  if (!row) throw new Error(`Job ${jobId} has no checkpoint to tamper with.`);

  const original = {
    patchPayload: row.patchPayload,
    patchSha256: row.patchSha256,
    patchByteSize: row.patchByteSize,
    patchCompressedBytes: row.patchCompressedBytes,
  };
  const checkpoint = await getLatestCheckpoint(jobId, {
    maxBytes: TEST_CONFIG.checkpointMaxBytes,
  });
  if (!checkpoint) throw new Error("The checkpoint could not be read before tampering.");

  const tampered = tamper(Buffer.from(checkpoint.restorePatch));
  const compressed = compressCheckpointPatch(tampered);
  await db
    .update(jobCheckpoints)
    .set({
      patchPayload: compressed,
      // The declared sizes stay consistent so the row is readable; whether the
      // checksum agrees is what each variant is actually testing.
      patchByteSize: tampered.byteLength,
      patchCompressedBytes: compressed.byteLength,
      patchSha256: tamper === flipOneByte ? row.patchSha256 : sha256CheckpointPatch(tampered),
    })
    .where(eq(jobCheckpoints.id, row.id));

  try {
    return await body();
  } finally {
    await db.update(jobCheckpoints).set(original).where(eq(jobCheckpoints.id, row.id));
  }
}

/** One byte changed, checksum left alone: the row no longer describes itself. */
function flipOneByte(patch: Buffer): Buffer {
  const copy = Buffer.from(patch);
  const index = Math.floor(copy.byteLength / 2);
  copy[index] = (copy[index] ?? 0) ^ 0xff;
  return copy;
}

/** A well-formed patch against a file the case does not have. */
function replaceWithUnappliablePatch(): Buffer {
  return Buffer.from(
    [
      "diff --git a/src/absent.js b/src/absent.js",
      "index 1111111..2222222 100644",
      "--- a/src/absent.js",
      "+++ b/src/absent.js",
      "@@ -1 +1 @@",
      "-const missing = 0;",
      "+const missing = 1;",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * Every checkpoint patch of one job, decompressed through the store's reader.
 *
 * The reader rather than a hand-rolled gunzip, so this searches exactly the
 * bytes a restore or a grade would see.
 */
async function readCheckpointPatches(jobId: string): Promise<string[]> {
  const rows = await db.select().from(jobCheckpoints).where(eq(jobCheckpoints.jobId, jobId));
  const patches: string[] = [];
  for (const row of rows.sort((left, right) => left.sequence - right.sequence)) {
    const checkpoint = await getCheckpoint(jobId, row.id, {
      maxBytes: TEST_CONFIG.checkpointMaxBytes,
    });
    if (checkpoint) patches.push(Buffer.from(checkpoint.restorePatch).toString("utf8"));
  }
  return patches;
}

function aggregatable(overrides: Partial<AggregatableEvaluationRun>): AggregatableEvaluationRun {
  const metrics: RunMetrics = {
    runtimeSeconds: 10,
    totalModelCalls: 1,
    totalToolCalls: 1,
    totalTurns: 1,
    totalInputTokens: 1,
    totalOutputTokens: 1,
    totalCostUsd: "0.0100",
    attemptCount: 1,
    reviewLoops: 0,
    reviewDecision: null,
    reviewBlockingCount: null,
    validationOutcome: null,
    newFailureCount: null,
    fixedFailureCount: null,
    filesChanged: null,
    insertions: null,
    deletions: null,
    hiddenTestsTotal: null,
    hiddenTestsPassed: null,
  };

  return {
    benchmarkId: CASE_ID,
    arm: "only",
    repetition: 1,
    result: "passed",
    score: 1,
    failureCategory: null,
    failureLabelSource: null,
    metrics,
    ...overrides,
    ...(overrides.failureCategory ? { failureLabelSource: "auto" as const } : {}),
  };
}

interface ScriptedJobOptions {
  plantSentinel?: boolean;
  writeDecoyHiddenTest?: boolean;
}

/** Runs one real job against a real container with a scripted implementation. */
async function runScriptedJob(
  label: string,
  source: string,
  options: ScriptedJobOptions,
): Promise<CompletedRun> {
  await worker?.close();
  await queue?.destroy();

  const probe = new SentinelProbe(dockerProvider(), options.plantSentinel === true);
  const testQueue = createTestQueue(`evaluation-sbx-${label}`, { attempts: 1 });
  queue = testQueue;
  worker = startTestWorker({
    queue: testQueue.queue,
    config: { ...TEST_CONFIG, pipelineSpeed: 0, sandbox: sandboxConfig() },
    phases: buildPipeline({
      sandbox: probe,
      image: sandboxImage(),
      workdir: WORKDIR,
      memoryBytes: 512 * 1_024 * 1_024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 128,
      commandTimeoutMs: 30_000,
      cloneTimeoutMs: 60_000,
      installTimeoutMs: 120_000,
      baselineTimeoutMs: 60_000,
      checkTimeoutMs: 60_000,
      diffMaxBytes: 262_144,
      validationReportMaxBytes: 1_048_576,
      targetedMaxFiles: 25,
      agent: {
        sessionTimeoutMs: 60_000,
        maxTurns: 4,
        previewMaxBytes: 512,
        fileMaxBytes: 16_384,
        coding: scriptedAgent(source, options.writeDecoyHiddenTest === true),
      },
      localSeed: localSeedOptions(),
    }),
  });

  const job = await createJob({
    title: "Apply the bulk discount per line",
    description: "Milestone 10 acceptance runs C, D and F.",
    repoUrl: "https://example.com/rivet/benchmark-placeholder",
    baseBranch: "main",
    reviewMode: "independent",
    maxReviewLoops: 2,
  });
  await db
    .update(jobs)
    .set({ repoUrl: `rivet-local:${CASE_ID}` })
    .where(eq(jobs.id, job.id));
  await enqueue(testQueue.queue, job.id, job.dispatchGeneration);
  const finished = await waitForStatus(job.id, ["completed", "failed"], {
    timeoutMs: JOB_TIMEOUT_MS,
  });

  await worker.close();
  await testQueue.destroy();
  worker = undefined;
  queue = undefined;

  return { jobId: job.id, status: finished.status, probe };
}

/**
 * Watches the job's container and searches it before it is destroyed.
 *
 * The production phase context does not hand its sandbox to a test, so the
 * probe wraps `destroy()` - the last moment the container exists - and asks it
 * two questions: does the sentinel appear anywhere on its filesystem, and does
 * a sentinel deliberately planted in the workspace survive the production
 * capture path into a compressed patch. The second is the positive control for
 * the first, and it runs after every assertion the job itself needed.
 */
class SentinelProbe implements SandboxProvider {
  readonly observations: Record<string, string> = {};

  constructor(
    private readonly delegate: SandboxProvider,
    private readonly plantSentinel: boolean,
  ) {}

  async create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
    const sandbox = await this.delegate.create(spec, signal);

    return {
      id: sandbox.id,
      exec: (request) => sandbox.exec(request),
      getFile: (path, fileOptions, fileSignal) => sandbox.getFile(path, fileOptions, fileSignal),
      putFile: (path, content, fileSignal) => sandbox.putFile(path, content, fileSignal),
      putArchive: (path, archive, archiveSignal) =>
        sandbox.putArchive(path, archive, archiveSignal),
      destroy: async () => {
        await this.observe(sandbox).catch((error: unknown) => {
          this.observations.probeError = String(error);
        });
        await sandbox.destroy();
      },
    };
  }

  reap(jobIsLive: Parameters<SandboxProvider["reap"]>[0]): ReturnType<SandboxProvider["reap"]> {
    return this.delegate.reap(jobIsLive);
  }

  private async observe(sandbox: Sandbox): Promise<void> {
    if (this.observations.containerMatches !== undefined) return;
    const signal = new AbortController().signal;

    const search = async (needle: string): Promise<string> => {
      const result = await sandbox.exec({
        argv: [
          "sh",
          "-c",
          // The whole filesystem, minus the kernel's synthetic trees. `-I`
          // skips binaries, which is what keeps this seconds rather than
          // minutes.
          `grep -rlI -- '${needle}' / ` +
            "--exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | sort",
        ],
        cwd: WORKDIR,
        timeoutMs: 180_000,
        signal,
        maxOutputBytes: 65_536,
      });
      return result.stdout.trim();
    };

    // The control runs first and deliberately looks for something the seeded
    // repository certainly contains. A search that silently fails - a quoting
    // mistake, a shell that is not there - returns nothing, and "nothing" is
    // also what a clean container returns, so the negative assertion is only
    // evidence once this one has found something.
    this.observations.controlMatches = await search("orderTotal");
    this.observations.containerMatches = await search(SENTINEL);

    if (!this.plantSentinel) return;

    // The positive control. Plant the sentinel, capture the workspace the way
    // every checkpoint is captured, compress it the way the store does, and
    // search the decompressed bytes with the same string.
    await sandbox.putFile(`${REPO_DIR}/src/planted.js`, `// ${SENTINEL}\n`, signal);
    const captured = await captureWorkspacePatch({
      sandbox,
      repositoryDir: REPO_DIR,
      signal,
      timeoutMs: 60_000,
      maxBytes: TEST_CONFIG.checkpointMaxBytes,
    });
    const compressed = compressCheckpointPatch(captured.patch);
    const roundTripped = decompressCheckpointPatch(
      compressed,
      TEST_CONFIG.checkpointMaxBytes,
    ).toString("utf8");
    this.observations.plantedPatchContainsSentinel = roundTripped.includes(SENTINEL) ? "yes" : "no";
  }
}

/** Records grading containers, and can break one step on request. */
class RecordingProvider implements SandboxProvider {
  readonly specs: SandboxSpec[] = [];
  readonly destroyed: string[] = [];

  constructor(
    private readonly delegate: SandboxProvider,
    private readonly options: { failPutFile?: (path: string) => boolean } = {},
  ) {}

  async create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
    this.specs.push(spec);
    const sandbox = await this.delegate.create(spec, signal);

    return {
      id: sandbox.id,
      exec: (request) => sandbox.exec(request),
      getFile: (path, options, fileSignal) => sandbox.getFile(path, options, fileSignal),
      putFile: (path, content, fileSignal) => {
        if (this.options.failPutFile?.(path)) {
          return Promise.reject(new Error("injected write failure"));
        }
        return sandbox.putFile(path, content, fileSignal);
      },
      putArchive: (path, archive, archiveSignal) =>
        sandbox.putArchive(path, archive, archiveSignal),
      destroy: async () => {
        await sandbox.destroy();
        this.destroyed.push(sandbox.id);
      },
    };
  }

  reap(jobIsLive: Parameters<SandboxProvider["reap"]>[0]): ReturnType<SandboxProvider["reap"]> {
    return this.delegate.reap(jobIsLive);
  }
}

function sandboxImage(): string {
  return process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
}

function sandboxConfig() {
  return {
    ...TEST_CONFIG.sandbox,
    mode: "docker" as const,
    image: sandboxImage(),
    workdir: WORKDIR,
    commandTimeoutMs: 30_000,
    cloneTimeoutMs: 60_000,
    installTimeoutMs: 120_000,
    baselineTimeoutMs: 60_000,
    checkTimeoutMs: 60_000,
    reapGraceMs: 0,
  };
}

function dockerProvider(): SandboxProvider {
  return new DockerSandboxProvider({
    workerId: `evaluation-sbx-${process.pid}`,
    reapGraceMs: 0,
  });
}

function localSeedOptions(): LocalSeedPipelineOptions {
  const options = createLocalSeedOptions(
    {
      mode: "on",
      benchmarkRoot: BENCHMARK_ROOT,
      fixtureRoot,
      cloneTimeoutMs: 120_000,
      seedMaxBytes: 64 * 1_024 * 1_024,
      concurrency: 1,
    },
    { repositoryRoot: fixtureRoot },
  );
  if (!options) throw new Error("RIVET_EVAL=on must produce a local seed source.");
  return options;
}

/** The rule the issue states: each line qualifies on its own quantity. */
function correctOrderTotal(): string {
  return [
    "export const BULK_QUANTITY = 10;",
    "export const BULK_DISCOUNT_PERCENT = 10;",
    "",
    "function assertLine(line) {",
    "  const { quantity, unitPriceCents } = line ?? {};",
    "  if (!Number.isInteger(quantity) || quantity < 0) {",
    '    throw new TypeError("quantity must be a non-negative integer");',
    "  }",
    "  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {",
    '    throw new TypeError("unitPriceCents must be a non-negative integer");',
    "  }",
    "}",
    "",
    "export function orderTotal(lines) {",
    '  if (!Array.isArray(lines)) throw new TypeError("lines must be an array");',
    "",
    "  let total = 0;",
    "  for (const line of lines) {",
    "    assertLine(line);",
    "    const gross = line.quantity * line.unitPriceCents;",
    "    total +=",
    "      line.quantity >= BULK_QUANTITY",
    "        ? Math.round((gross * (100 - BULK_DISCOUNT_PERCENT)) / 100)",
    "        : gross;",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n");
}

/** The order-level reading: green on the public suite, wrong on the issue. */
function publicOnlyOrderTotal(): string {
  return [
    "export const BULK_QUANTITY = 10;",
    "export const BULK_DISCOUNT_PERCENT = 10;",
    "",
    "function assertLine(line) {",
    "  const { quantity, unitPriceCents } = line ?? {};",
    "  if (!Number.isInteger(quantity) || quantity < 0) {",
    '    throw new TypeError("quantity must be a non-negative integer");',
    "  }",
    "  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {",
    '    throw new TypeError("unitPriceCents must be a non-negative integer");',
    "  }",
    "}",
    "",
    "export function orderTotal(lines) {",
    '  if (!Array.isArray(lines)) throw new TypeError("lines must be an array");',
    "",
    "  let total = 0;",
    "  let quantity = 0;",
    "  for (const line of lines) {",
    "    assertLine(line);",
    "    total += line.quantity * line.unitPriceCents;",
    "    quantity += line.quantity;",
    "  }",
    "  return quantity >= BULK_QUANTITY",
    "    ? Math.round((total * (100 - BULK_DISCOUNT_PERCENT)) / 100)",
    "    : total;",
    "}",
    "",
  ].join("\n");
}

/** A decoy the case's own hidden test must overwrite during grading. */
const DECOY_HIDDEN_TEST = [
  "import { test } from 'node:test';",
  "",
  "test('a test the session wrote for itself', () => {});",
  "",
].join("\n");

function scriptedAgent(source: string, writeDecoyHiddenTest: boolean): FakeCodingAgent {
  const session: ScriptedSession = {
    events: [
      {
        type: "session_started",
        sessionId: "evaluation-implementation",
        model: "fixture-model",
        provider: "fixture-provider",
        toolNames: ["bash", "edit", "read", "write"],
      },
      { type: "turn_started", turn: 0 },
      { type: "assistant_message", turn: 0, text: "Applied the discount rule." },
      { type: "turn_completed", turn: 0 },
      { type: "session_ended", reason: "completed", turns: 1, usage: USAGE },
    ],
    useTools: async (tools: ImplementerAgentToolbox, signal: AbortSignal) => {
      await tools.writeFile(`${REPO_DIR}/src/order.js`, source, signal);
      if (writeDecoyHiddenTest) {
        await tools.writeFile(`${REPO_DIR}/hidden/order.hidden.test.js`, DECOY_HIDDEN_TEST, signal);
      }
    },
  };

  return new FakeCodingAgent({
    script: [session],
    reviewerScript: { review: approvingReview() },
  });
}

async function runGit(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  const [command, ...args] = argv;
  if (!command) throw new Error("Missing command");
  return runFile(command, args, { encoding: "utf8", maxBuffer: 16 * 1_024 * 1_024 });
}
