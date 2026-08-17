import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { EvaluationArm, EvaluationSuite } from "@rivet/contracts";
import {
  buildBenchmarkFixtures,
  buildPipeline,
  getArtifact,
  getJob,
  listArtifacts,
  listEvaluationRuns,
  readValidationReport,
  SandboxCreateFailedError,
  summarizeEvaluationRuns,
  type EvaluationRunRecord,
  type LocalSeedPipelineOptions,
  type Sandbox,
  type SandboxProvider,
  type SandboxSpec,
} from "@rivet/core";
import { db, jobs } from "@rivet/database";
import { FakeSandboxProvider, type ScriptedCommand } from "@rivet/sandbox";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildMetrics,
  prepareEvaluationCases,
  regradeEvaluationSuite,
  runEvaluationSuite,
  type EvaluationRuntime,
} from "../../src/eval-run";
import {
  AGENT_OPTIONS,
  approvingReview,
  COMMIT,
  DIFF,
  FakeCodingAgent,
  fixtureProvider,
  PIPELINE_OPTIONS,
  successfulSession,
  TREE,
} from "./review-fixture";
import {
  closeConnections,
  createTestQueue,
  resetDatabase,
  startTestWorker,
  TEST_CONFIG,
  type TestQueue,
  type TestWorker,
} from "./support";

/**
 * Acceptance runs E and G: what must not be counted, and what must not drift.
 *
 * Both are about the failure mode an evaluation harness actually dies of - a
 * number that is wrong in a way nobody notices.
 *
 * **Run E** is the classification order. A job that failed in `provisioning`
 * never produced work anybody could judge, so it is `errored` rather than
 * `ungraded`, and it costs no grading container: infrastructure failures arrive
 * in bursts, and a grader that provisions one to discover there is nothing to
 * grade pays for every one of them. Its mirror image - a job that reached a
 * *task* failure after checkpointing - is `failed` and does provision, because
 * a tree that changed nothing still has hidden tests to fail. Read together,
 * the two cases assert the classifier is being consulted rather than "did the
 * job complete".
 *
 * **Run G** is the denormalized metric snapshot. `metrics_json` exists so a
 * later change to how a metric is computed cannot silently rewrite history,
 * which is only true if it is written from the sources the acceptance document
 * names and never re-read from them afterwards. So every field is compared
 * against its source right now, and then the job row is changed underneath a
 * graded run to prove the stored snapshot does not move.
 *
 * The sandbox is scripted here, deliberately: every assertion in this file is
 * about Postgres rows, the runner's control flow, and the grader's use of the
 * `Sandbox` port. The bytes inside a container are runs B, C, D and F, and they
 * live in the sandbox suite because asserting them against a fake would be
 * asserting the fake.
 */

const BENCHMARK_ROOT = resolve(import.meta.dirname, "../fixtures/benchmarks");
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");
const PASS_CASE = "fixture-pass";
const PARTIAL_CASE = "fixture-partial";

const GREEN_TAP = ["TAP version 13", "# tests 6", "# pass 6", "# fail 0", "# skipped 0", ""].join(
  "\n",
);
const RED_TAP = ["TAP version 13", "# tests 6", "# pass 2", "# fail 4", "# skipped 0", ""].join(
  "\n",
);

let queue: TestQueue | undefined;
let worker: TestWorker | undefined;

beforeEach(async () => {
  await resetDatabase();
  await resetEvaluationTables();
});

afterEach(async () => {
  await worker?.close();
  await queue?.destroy();
  worker = undefined;
  queue = undefined;
});

afterAll(async () => {
  await closeConnections();
});

describe("Milestone 10 evaluation runs", () => {
  it("E: errors an infrastructure failure, passes its neighbour, and counts both", async () => {
    // One suite, two cases, and a sandbox that refuses to create a container
    // for exactly one of them. Running both under one runner is the point: the
    // averaging the plan forbids - an infrastructure failure folded into a task
    // success rate - is only observable when both are in the same table.
    const grading = gradingProvider(GREEN_TAP);
    const suiteId = await runSuite({
      caseIds: [PASS_CASE, PARTIAL_CASE],
      jobSandbox: new FailingCreateProvider(fixtureProvider(), PARTIAL_CASE),
      grading,
    });
    const runs = await listEvaluationRuns(suiteId);

    const passed = runFor(runs, PASS_CASE);
    const errored = runFor(runs, PARTIAL_CASE);

    expect(passed.result).toBe("passed");
    expect(errored.result).toBe("errored");
    // `ungraded` is the tempting wrong answer: there is no checkpoint, so
    // grading could not run. It is reserved for a job that *could* have been
    // graded and whose grading broke, which is run F.
    expect(errored.result).not.toBe("ungraded");
    expect(errored.score).toBeNull();
    expect(errored.gradedAt).not.toBeNull();
    expect(errored.jobId).not.toBeNull();
    expect(errored.failureCategory).toBe("Environment failure");
    expect(errored.failureLabelSource).toBe("auto");

    // Judged from the row, so the snapshot still carries what the job did
    // record and reports nothing where it produced nothing.
    expect(errored.metrics.attemptCount).toBeGreaterThan(0);
    expect(errored.metrics.hiddenTestsTotal).toBeNull();
    expect(errored.metrics.validationOutcome).toBeNull();

    const erroredJob = await getJob(errored.jobId ?? "");
    expect(erroredJob?.status).toBe("failed");
    expect(erroredJob?.failureCategory).toBe("sandbox_create_failed");

    // Asserted against the port rather than inferred from timing: exactly one
    // grading container existed, and it belonged to the run that had a
    // workspace to grade.
    expect(grading.created).toHaveLength(1);
    expect(grading.created[0]?.jobId).toBe(passed.jobId);
    expect(grading.sandboxes.every((sandbox) => sandbox.destroyed)).toBe(true);

    // All three numbers in one assertion, because reporting the success rate
    // without the errored count is exactly the averaging the plan forbids.
    const summary = summarizeEvaluationRuns(runs);
    expect(summary.overall.total).toBe(2);
    expect(summary.overall.errored).toBe(1);
    expect(summary.overall.passed).toBe(1);
    expect(summary.overall.graded).toBe(1);
    expect(summary.overall.successRate).toBe(1);
  }, 180_000);

  it("E: grades a task failure that produced a workspace, in a grading container", async () => {
    // The opposite shape. A job that changed nothing fails validation with
    // `no_changes_produced`, which is a statement about the work rather than
    // about the machine - so it is graded, in a container, and it fails.
    // The job changed nothing, so its checkpoint patch is empty and the
    // grading container must re-derive the same emptiness.
    const grading = gradingProvider(RED_TAP, "");
    const suiteId = await runSuite({
      caseIds: [PASS_CASE],
      jobSandbox: fixtureProvider([
        { match: (argv) => argv[0] === "git" && argv[1] === "diff", stdout: "" },
      ]),
      grading,
    });
    const run = runFor(await listEvaluationRuns(suiteId), PASS_CASE);

    const job = await getJob(run.jobId ?? "");
    expect(job?.failureCategory).toBe("no_changes_produced");
    expect(run.result).toBe("failed");
    expect(run.result).not.toBe("errored");
    expect(run.score).toBeCloseTo(2 / 6, 4);
    expect(run.metrics.hiddenTestsTotal).toBe(6);
    expect(run.metrics.hiddenTestsPassed).toBe(2);

    expect(grading.created).toHaveLength(1);
    expect(grading.sandboxes.every((sandbox) => sandbox.destroyed)).toBe(true);
  }, 180_000);

  it("G: writes metrics that agree with the job row and its artifacts", async () => {
    const suiteId = await runSuite({
      caseIds: [PASS_CASE],
      jobSandbox: fixtureProvider(),
      grading: gradingProvider(GREEN_TAP),
      arms: [
        { label: "independent", jobPatch: { reviewMode: "independent" } },
        { label: "none", jobPatch: { reviewMode: "none" } },
      ],
    });
    const runs = await listEvaluationRuns(suiteId);

    const reviewed = armRun(runs, "independent");
    const unreviewed = armRun(runs, "none");
    expect(reviewed.result).toBe("passed");
    expect(unreviewed.result).toBe("passed");

    // Field by field, against the sources the acceptance document names, read
    // back right now rather than remembered from the run.
    const job = await getJob(reviewed.jobId ?? "");
    if (!job) throw new Error("The graded job is gone.");
    expect(reviewed.metrics).toEqual(
      buildMetrics(job, await readValidationReport(job.id), null, await readDiffStat(job.id), {
        total: 6,
        passed: 6,
        failed: 0,
        skipped: 0,
        parsed: true,
      }),
    );
    expect(reviewed.metrics.runtimeSeconds).toBe(
      Math.round(((job.completedAt?.getTime() ?? 0) - (job.startedAt?.getTime() ?? 0)) / 1_000),
    );
    // A string the whole way through, because the column is `numeric(10,4)` and
    // the one thing this harness must not do is report a cost a float rounded.
    expect(reviewed.metrics.totalCostUsd).toBe(job.totalCostUsd);
    expect(typeof reviewed.metrics.totalCostUsd).toBe("string");
    expect(reviewed.metrics.filesChanged).toBe(1);
    expect(reviewed.metrics.insertions).toBe(1);
    expect(reviewed.metrics.deletions).toBe(1);
    expect(reviewed.metrics.newFailureCount).not.toBeNull();
    expect(reviewed.metrics.hiddenTestsPassed).toBe(reviewed.metrics.hiddenTestsTotal);

    // The M8 distinction carried into the metrics: "no reviewer looked at this"
    // and "a reviewer had nothing to say" stay different facts. An arm labelled
    // `none` reporting a decision would invalidate Experiment 1.
    expect(reviewed.metrics.reviewDecision).toBe("approve");
    expect(reviewed.metrics.reviewBlockingCount).toBe(0);
    expect(unreviewed.metrics.reviewDecision).toBeNull();
    expect(unreviewed.metrics.reviewBlockingCount).toBeNull();
  }, 180_000);

  it("G: keeps a graded snapshot immutable when its job row changes afterwards", async () => {
    const suiteId = await runSuite({
      caseIds: [PASS_CASE],
      jobSandbox: fixtureProvider(),
      grading: gradingProvider(GREEN_TAP),
    });
    const run = runFor(await listEvaluationRuns(suiteId), PASS_CASE);
    const before = run.metrics;

    // History a later write can rewrite is not history.
    await db
      .update(jobs)
      .set({ totalCostUsd: "9.9999", totalModelCalls: 999 })
      .where(eq(jobs.id, run.jobId ?? ""));

    const reread = runFor(await listEvaluationRuns(suiteId), PASS_CASE);
    expect(reread.metrics).toEqual(before);
    expect(reread.metrics.totalCostUsd).not.toBe("9.9999");
  }, 180_000);

  it("D: re-grades a finished suite from stored patches, with no worker and no job", async () => {
    // `pnpm eval:grade`'s reason to exist. The patch is in Postgres and the case
    // is in git, so a corrected hidden test can re-score history months later
    // without a single model call - and re-scoring must reproduce the same
    // verdict when nothing changed.
    const grading = gradingProvider(GREEN_TAP);
    const suiteId = await runSuite({
      caseIds: [PASS_CASE],
      jobSandbox: fixtureProvider(),
      grading,
    });
    const before = runFor(await listEvaluationRuns(suiteId), PASS_CASE);

    // No worker, no queue: this is a read of finished work.
    await worker?.close();
    await queue?.destroy();
    worker = undefined;
    queue = undefined;

    const fixtures = await mkdtemp(join(tmpdir(), "rivet-evaluation-regrade-"));
    try {
      await buildBenchmarkFixtures({
        benchmarkRoot: BENCHMARK_ROOT,
        outputRoot: fixtures,
        lockfileMode: "verify",
      });
      const regraded = await regradeEvaluationSuite(suiteId, {
        runtime: runtimeFor(grading, fixtures),
        repositoryRoot: REPOSITORY_ROOT,
        log: () => undefined,
      });

      const after = regraded.find((run) => run.benchmarkId === PASS_CASE);
      expect(after?.result).toBe(before.result);
      expect(after?.score).toBe(before.score);
      expect(after?.metrics.hiddenTestsTotal).toBe(before.metrics.hiddenTestsTotal);
      expect(after?.metrics.hiddenTestsPassed).toBe(before.metrics.hiddenTestsPassed);
      // Written back to the same row rather than appended as a second verdict.
      expect(regraded).toHaveLength(1);
      // And the case identity travels with the grade: a re-score that quietly
      // overwrote which case it scored is the "two runs of the same task that
      // were not the same task" failure arriving through the back door.
      expect(after?.caseVersionHash).toBe(before.caseVersionHash);
      expect(grading.created.length).toBe(2);
    } finally {
      await rm(fixtures, { recursive: true, force: true });
    }
  }, 180_000);

  it("H: a concurrent matrix produces the same rows a serial one does", async () => {
    // Run H asserts `RIVET_EVAL_CONCURRENCY` at 1 and at 2. The paid demo runs
    // the serial half; this is the cheap half, and it asserts the property that
    // actually matters: concurrency that changes results is concurrency that is
    // grading a shared container.
    const serialId = await runSuite({
      caseIds: [PASS_CASE, PARTIAL_CASE],
      jobSandbox: fixtureProvider(),
      grading: gradingProvider(GREEN_TAP),
      concurrency: 1,
    });
    const serial = await listEvaluationRuns(serialId);

    await worker?.close();
    await queue?.destroy();
    worker = undefined;
    queue = undefined;

    const parallelId = await runSuite({
      caseIds: [PASS_CASE, PARTIAL_CASE],
      jobSandbox: fixtureProvider(),
      grading: gradingProvider(GREEN_TAP),
      concurrency: 2,
    });
    const parallel = await listEvaluationRuns(parallelId);

    expect(parallel).toHaveLength(serial.length);
    expect(parallel.map((run) => `${run.benchmarkId}/${run.arm}/${run.repetition}`).sort()).toEqual(
      serial.map((run) => `${run.benchmarkId}/${run.arm}/${run.repetition}`).sort(),
    );
    expect(parallel.map((run) => run.result).sort()).toEqual(
      serial.map((run) => run.result).sort(),
    );
    expect(parallel.map((run) => run.score).sort()).toEqual(serial.map((run) => run.score).sort());

    // Distinct jobs, none null, and the unique constraint held for both.
    const jobIds = new Set(parallel.map((run) => run.jobId));
    expect(jobIds.size).toBe(parallel.length);
    expect(jobIds.has(null)).toBe(false);

    const summary = summarizeEvaluationRuns(parallel);
    expect(summary.overall).toEqual(summarizeEvaluationRuns(serial).overall);
  }, 240_000);
});

/** The evaluation tables the job truncation does not reach. */
async function resetEvaluationTables(): Promise<void> {
  await db.execute(
    sql`truncate table evaluation_runs, evaluation_suites, benchmark_cases restart identity cascade`,
  );
}

function runFor(runs: readonly EvaluationRunRecord[], benchmarkId: string): EvaluationRunRecord {
  const run = runs.find((candidate) => candidate.benchmarkId === benchmarkId);
  if (!run) throw new Error(`No evaluation run for ${benchmarkId}.`);
  return run;
}

function armRun(runs: readonly EvaluationRunRecord[], arm: string): EvaluationRunRecord {
  const run = runs.find((candidate) => candidate.arm === arm);
  if (!run) throw new Error(`No evaluation run for arm ${arm}.`);
  return run;
}

interface SuiteInput {
  caseIds: string[];
  jobSandbox: SandboxProvider;
  grading: FakeSandboxProvider;
  arms?: EvaluationArm[];
  concurrency?: number;
}

/**
 * Runs the production runner against a worker this suite owns.
 *
 * `startWorker: false` is the only accommodation: `runEvaluationSuite` normally
 * spawns `pnpm --filter @rivet/worker start`, which would want Docker, a model
 * key and the real switch family. Everything else - the suite row, job
 * creation, enqueueing, the terminal wait, grading and the run rows - is the
 * path `pnpm eval:run` takes.
 */
async function runSuite(input: SuiteInput): Promise<string> {
  const testQueue = createTestQueue("evaluation-int", { attempts: 1 });
  queue = testQueue;
  worker = startTestWorker({
    queue: testQueue.queue,
    config: { ...TEST_CONFIG, pipelineSpeed: 0 },
    phases: buildPipeline({
      ...PIPELINE_OPTIONS,
      sandbox: input.jobSandbox,
      agent: { ...AGENT_OPTIONS, coding: codingAgent() },
      localSeed: seedOptions(),
    }),
  });

  const suite: EvaluationSuite = {
    label: "milestone-10-acceptance",
    arms: input.arms ?? [{ label: "only", jobPatch: {} }],
    repetitions: 1,
    caseIds: input.caseIds,
  };
  const benchmarks = await prepareEvaluationCases(BENCHMARK_ROOT, suite);

  const result = await runEvaluationSuite({
    suite,
    benchmarks,
    runtime: runtimeFor(input.grading),
    queue: testQueue.queue,
    repositoryRoot: REPOSITORY_ROOT,
    startWorker: false,
    concurrency: input.concurrency ?? 1,
    waitTimeoutMs: 90_000,
    log: () => undefined,
  });
  return result.suiteId;
}

function runtimeFor(grading: FakeSandboxProvider, fixtureRoot?: string): EvaluationRuntime {
  return {
    config: {
      ...TEST_CONFIG,
      eval: {
        ...TEST_CONFIG.eval,
        mode: "on",
        benchmarkRoot: BENCHMARK_ROOT,
        ...(fixtureRoot === undefined ? {} : { fixtureRoot }),
      },
    },
    sandbox: grading,
    localSeed: seedOptions(),
  };
}

/**
 * A seed that hands back the commit the scripted container reports.
 *
 * The grader compares the seed's commit against the checkpoint's base commit
 * before it applies anything, because a patch cut against one benchmark's base
 * will often apply cleanly to another's. Here they agree by construction; run F
 * is where they deliberately do not.
 */
function seedOptions(): LocalSeedPipelineOptions {
  return {
    seed: () =>
      Promise.resolve({
        archive: new Uint8Array([0x1f, 0x8b, 0x00]),
        commitSha: COMMIT,
        treeSha: TREE,
      }),
    seedMaxBytes: 64 * 1_024 * 1_024,
    cloneTimeoutMs: 5_000,
  };
}

/**
 * The grading container: applies the patch, re-derives it, runs the case.
 *
 * `patch` is what the re-derivation answers, and it must be what the job's own
 * capture produced - that comparison is the grader's proof it is scoring the
 * tree the job left behind, and a fixture that disagreed with itself would be
 * `ungraded` rather than graded.
 */
function gradingProvider(tap: string, patch = DIFF): FakeSandboxProvider {
  const script: ScriptedCommand[] = [
    { match: (argv) => argv[0] === "git" && argv[1] === "apply", exitCode: 0 },
    { match: (argv) => argv[0] === "git" && argv[1] === "write-tree", stdout: `${TREE}\n` },
    {
      match: (argv) => argv[0] === "git" && argv[1] === "diff" && argv.includes("--cached"),
      stdout: patch,
    },
    { match: "node", stdout: tap, exitCode: tap.includes("# fail 0") ? 0 : 1 },
  ];
  return new FakeSandboxProvider({ script });
}

/** One implementation turn and an approving reviewer, as M8's fixtures do. */
function codingAgent(): FakeCodingAgent {
  return new FakeCodingAgent({
    script: [successfulSession("evaluation-implementation")],
    reviewerScript: { review: approvingReview() },
  });
}

/**
 * Fails `create` for one case's jobs and delegates every other call.
 *
 * The decision is read from the job row rather than from call order, so the
 * suite's two cases stay independent of how the runner happens to interleave
 * them.
 */
class FailingCreateProvider implements SandboxProvider {
  constructor(
    private readonly delegate: SandboxProvider,
    private readonly caseId: string,
  ) {}

  async create(spec: SandboxSpec, signal: AbortSignal): Promise<Sandbox> {
    const job = await getJob(spec.jobId);
    if (job?.repoUrl.endsWith(this.caseId)) {
      throw new SandboxCreateFailedError("injected create failure");
    }
    return this.delegate.create(spec, signal);
  }

  reap(jobIsLive: Parameters<SandboxProvider["reap"]>[0]): ReturnType<SandboxProvider["reap"]> {
    return this.delegate.reap(jobIsLive);
  }
}

/** The `diff_stat` totals, read back the way the runner reads them. */
async function readDiffStat(
  jobId: string,
): Promise<{ filesChanged: number; insertions: number; deletions: number } | null> {
  const artifacts = await listArtifacts(jobId);
  const stat = [...artifacts].reverse().find((artifact) => artifact.type === "diff_stat");
  if (!stat) return null;

  const metadata = stat.metadata ?? {};
  const filesChanged = metadata.filesChanged;
  const insertions = metadata.insertions;
  const deletions = metadata.deletions;
  if (
    typeof filesChanged === "number" &&
    typeof insertions === "number" &&
    typeof deletions === "number"
  ) {
    return { filesChanged, insertions, deletions };
  }

  const content = await getArtifact(jobId, stat.id);
  if (!content) return null;
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of content.content.split(/\r?\n/u)) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    files += 1;
    added += Number(fields[0]) || 0;
    removed += Number(fields[1]) || 0;
  }
  return { filesChanged: files, insertions: added, deletions: removed };
}
