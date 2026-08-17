/* eslint-disable no-console -- evaluation commands are intentionally terminal-oriented */
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluationSuiteSchema,
  formatLocalRepoUrl,
  isTerminal,
  runMetricsSchema,
  type EvaluationArm,
  type EvaluationRun,
  type EvaluationSuite,
  type FailureLabelSource,
  type JobDetail,
  type RunMetrics,
  type RunResult,
  type ValidationReport,
} from "@rivet/contracts";
import {
  createEvaluationSuite,
  createJob,
  getEvaluationSuite,
  getJob,
  getLatestCheckpoint,
  getArtifact,
  gradeEvaluationRun,
  listArtifacts,
  listEvaluationRuns,
  listEvents,
  loadBenchmarkCases,
  loadHiddenTestFiles,
  readValidation,
  readValidationReport,
  recordEvaluationRun,
  requestJobRun,
  resolveBenchmarkRepositoryPath,
  type GradeEvaluationRunResult,
  type LoadedBenchmarkCase,
  type SandboxProvider,
  type ValidationRecord,
  updateEvaluationRunGrade,
  updateEvaluationSuiteStatus,
  upsertBenchmarkCase,
} from "@rivet/core";
import { closeDb } from "@rivet/database";
import { closeJobQueue, closeRedis, getBullJobQueue, type BullJobQueue } from "@rivet/queue";
import { DockerSandboxProvider } from "@rivet/sandbox";

import {
  DEFAULT_BENCHMARK_FIXTURE_ROOT,
  DEFAULT_BENCHMARK_ROOT,
  DEFAULT_MODEL,
  DEFAULT_MODEL_PROVIDER,
  findRepositoryRoot,
  loadRootEnv,
  parseWorkerConfig,
  type WorkerConfig,
} from "./config";
import { createLocalSeedOptions, resolveRoot } from "./eval";

const DEFAULT_SUITE_LABEL = "reviewer-value";
const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_MAX_MODEL_CALLS = 200;
const DEFAULT_MAX_TOOL_CALLS = 500;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_WAIT_GRACE_MS = 30_000;
const MAX_CONCURRENCY = 50;
const DEFAULT_ARMS: readonly EvaluationArm[] = [
  { label: "independent", jobPatch: { reviewMode: "independent" } },
  { label: "none", jobPatch: { reviewMode: "none" } },
];

const CHILD_WORKER_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/** A case with the hidden test files loaded once for all repetitions. */
export interface PreparedEvaluationCase extends LoadedBenchmarkCase {
  hiddenFiles: Awaited<ReturnType<typeof loadHiddenTestFiles>>;
}

/** One cell in the deterministic case x arm x repetition matrix. */
export interface EvaluationMatrixCell {
  index: number;
  benchmark: PreparedEvaluationCase;
  arm: EvaluationArm;
  repetition: number;
}

/** Runtime dependencies owned by the CLI, not by the domain package. */
export interface EvaluationRuntime {
  config: WorkerConfig;
  sandbox: SandboxProvider;
  localSeed: NonNullable<ReturnType<typeof createLocalSeedOptions>>;
}

/** The result of waiting for a job before grading it. */
export interface WaitForTerminalResult {
  job: JobDetail | null;
  reason: "terminal" | "timeout" | "worker_exited" | "missing";
}

/** Options for the exported matrix runner. */
export interface RunEvaluationOptions {
  suite: EvaluationSuite;
  benchmarks: readonly PreparedEvaluationCase[];
  runtime: EvaluationRuntime;
  queue: BullJobQueue;
  repositoryRoot: string;
  startWorker?: boolean;
  worker?: ChildProcess;
  concurrency?: number;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/** The persisted suite and all individual result rows. */
export interface RunEvaluationResult {
  suiteId: string;
  runs: readonly EvaluationRun[];
}

/**
 * Builds the matrix in stable order. The order is part of the CLI's dry-run
 * contract and keeps a repeated suite easy to compare in a terminal or log.
 */
export function buildEvaluationMatrix(
  suite: EvaluationSuite,
  benchmarks: readonly PreparedEvaluationCase[],
): EvaluationMatrixCell[] {
  const byId = new Map(benchmarks.map((benchmark) => [benchmark.id, benchmark]));
  const cells: EvaluationMatrixCell[] = [];
  let index = 0;

  for (const caseId of suite.caseIds) {
    const benchmark = byId.get(caseId);
    if (!benchmark) {
      throw new Error(`Evaluation suite names unknown benchmark case ${caseId}.`);
    }
    for (const arm of suite.arms) {
      for (let repetition = 1; repetition <= suite.repetitions; repetition += 1) {
        cells.push({ index, benchmark, arm, repetition });
        index += 1;
      }
    }
  }

  return cells;
}

/** Formats the matrix without reading Postgres, Redis or starting a worker. */
export function formatEvaluationMatrix(
  suite: EvaluationSuite,
  benchmarks: readonly PreparedEvaluationCase[],
): string {
  const cells = buildEvaluationMatrix(suite, benchmarks);
  const lines = [
    `Evaluation matrix: ${cells.length} run${cells.length === 1 ? "" : "s"}`,
    `Suite: ${suite.label}`,
    `Cases: ${suite.caseIds.length}, arms: ${suite.arms.length}, repetitions: ${suite.repetitions}`,
    "",
    "#\tcase\tarm\trepetition\tmax duration\tmax cost",
  ];

  for (const cell of cells) {
    const patch = cell.arm.jobPatch;
    const duration = patch.maxDurationSeconds ?? cell.benchmark.spec.maxDurationSeconds;
    const cost = patch.maxCostUsd ?? cell.benchmark.spec.maxCostUsd;
    lines.push(
      `${cell.index + 1}\t${cell.benchmark.id}\t${cell.arm.label}\t${cell.repetition}\t` +
        `${duration}s\t$${cost}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Loads cases selected by a suite and verifies the two reproducibility pins
 * before any paid work or database row is created. Re-grading may explicitly
 * allow a changed hidden-test hash so corrected tests can re-score old jobs.
 */
export async function prepareEvaluationCases(
  benchmarkRoot: string,
  suite: EvaluationSuite,
  options: {
    fixtureRoot?: string;
    requireBuiltRepositories?: boolean;
    allowVersionMismatch?: boolean;
  } = {},
): Promise<PreparedEvaluationCase[]> {
  const loaded = await loadBenchmarkCases(benchmarkRoot);
  const byId = new Map(loaded.map((benchmark) => [benchmark.id, benchmark]));
  const prepared: PreparedEvaluationCase[] = [];

  for (const caseId of suite.caseIds) {
    const benchmark = byId.get(caseId);
    if (!benchmark) {
      throw new Error(`Evaluation suite names benchmark case ${caseId}, but it is not on disk.`);
    }
    if (!benchmark.lock) {
      throw new Error(
        `Benchmark ${caseId} has no case.lock.json. Run pnpm eval:build before running it.`,
      );
    }
    if (!options.allowVersionMismatch && benchmark.lock.versionHash !== benchmark.versionHash) {
      throw new Error(
        `Benchmark ${caseId} changed since it was built. Run pnpm eval:build and review its ` +
          "case.lock.json before spending model calls.",
      );
    }

    if (options.requireBuiltRepositories) {
      if (!options.fixtureRoot)
        throw new Error("A fixture root is required for a real evaluation.");
      await resolveBenchmarkRepositoryPath({
        repoUrl: formatLocalRepoUrl(caseId),
        fixtureRoot: options.fixtureRoot,
      });
    }

    prepared.push({
      ...benchmark,
      hiddenFiles: await loadHiddenTestFiles(benchmark.hiddenDirectory),
    });
  }

  return prepared;
}

/**
 * Parses worker configuration for the runner without requiring a model key.
 *
 * The runner process never creates a coding session. The child worker, when
 * requested, receives the real environment and performs the normal model-key
 * validation itself. Removing NODE_ENV here keeps the runner's local Docker
 * grader from tripping the production-only worker switch guards.
 */
export function parseEvaluationRuntimeConfig(
  env: Record<string, string | undefined>,
): WorkerConfig {
  const runnerEnv: Record<string, string | undefined> = {
    ...env,
    RIVET_AGENT: "off",
    RIVET_EVAL: "off",
    RIVET_GITHUB: "off",
  };
  delete runnerEnv.NODE_ENV;
  delete runnerEnv.RIVET_AGENT_SCRIPT;
  return parseWorkerConfig(runnerEnv);
}

/** Runs the complete matrix and writes one evaluation row per cell. */
export async function runEvaluationSuite(
  options: RunEvaluationOptions,
): Promise<RunEvaluationResult> {
  const concurrency = resolveConcurrency(
    options.concurrency ?? options.runtime.config.eval.concurrency,
  );
  const signal = options.signal ?? new AbortController().signal;
  const log = options.log ?? console.log;
  const cells = buildEvaluationMatrix(options.suite, options.benchmarks);
  for (const benchmark of options.benchmarks) {
    if (!benchmark.lock) {
      throw new Error(`Benchmark ${benchmark.id} has no case.lock.json.`);
    }
    await upsertBenchmarkCase({
      versionHash: benchmark.versionHash,
      baseCommitSha: benchmark.lock.baseCommitSha,
      spec: benchmark.spec,
    });
  }
  const suite = await createEvaluationSuite(options.suite);
  const ownedWorker =
    options.worker === undefined && options.startWorker !== false
      ? startEvaluationWorker(options.repositoryRoot, concurrency)
      : undefined;
  const worker = options.worker ?? ownedWorker;
  let completed = false;

  try {
    await runWithConcurrency(cells, concurrency, async (cell) => {
      signal.throwIfAborted();
      const run = await runEvaluationCell({
        suiteId: suite.id,
        cell,
        runtime: options.runtime,
        queue: options.queue,
        ...(worker ? { worker } : {}),
        ...(options.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: options.waitTimeoutMs }),
        signal,
        log,
      });
      log(
        `${cell.benchmark.id} / ${cell.arm.label} / repetition ${cell.repetition}: ` +
          `${run.result}${run.score === null ? "" : ` (${run.score.toFixed(4)})`}`,
      );
    });

    completed = true;
    return {
      suiteId: suite.id,
      runs: await listEvaluationRuns(suite.id),
    };
  } finally {
    // A suite with a terminal row for every cell is completed even when some
    // cells are errored or ungraded. An interruption leaves the matrix visibly
    // incomplete and is therefore aborted rather than quietly successful.
    try {
      const latest = await getEvaluationSuite(suite.id);
      if (latest) {
        const status = completed ? "completed" : "aborted";
        await updateEvaluationSuiteStatus({ id: latest.id, status }).catch(() => undefined);
      }
    } catch {
      // Preserve the original runner error if the status read itself fails.
    } finally {
      await stopEvaluationWorker(ownedWorker);
    }
  }
}

/** Re-grades the stored jobs in a suite without creating model jobs. */
export async function regradeEvaluationSuite(
  suiteId: string,
  options: {
    runtime: EvaluationRuntime;
    repositoryRoot: string;
    signal?: AbortSignal;
    concurrency?: number;
    log?: (message: string) => void;
  },
): Promise<readonly EvaluationRun[]> {
  const suite = await getEvaluationSuite(suiteId);
  if (!suite) throw new Error(`Evaluation suite ${suiteId} was not found.`);

  const benchmarks = await prepareEvaluationCases(
    resolveRoot(options.runtime.config.eval.benchmarkRoot, options.repositoryRoot),
    suite,
    {
      fixtureRoot: resolveRoot(options.runtime.config.eval.fixtureRoot, options.repositoryRoot),
      requireBuiltRepositories: true,
      allowVersionMismatch: true,
    },
  );
  for (const benchmark of benchmarks) {
    if (!benchmark.lock) {
      throw new Error(`Benchmark ${benchmark.id} has no case.lock.json.`);
    }
    await upsertBenchmarkCase({
      versionHash: benchmark.versionHash,
      baseCommitSha: benchmark.lock.baseCommitSha,
      spec: benchmark.spec,
    });
  }
  const byId = new Map(benchmarks.map((benchmark) => [benchmark.id, benchmark]));
  const rows = await listEvaluationRuns(suiteId);
  const concurrency = resolveConcurrency(
    options.concurrency ?? options.runtime.config.eval.concurrency,
  );
  const signal = options.signal ?? new AbortController().signal;
  const log = options.log ?? console.log;

  await runWithConcurrency(rows, concurrency, async (row) => {
    signal.throwIfAborted();
    const benchmark = byId.get(row.benchmarkId);
    if (!benchmark) throw new Error(`Stored run names missing benchmark ${row.benchmarkId}.`);

    const graded = await regradeStoredRun(row, benchmark, options.runtime, signal);
    await updateEvaluationRunGrade({
      id: row.id,
      caseVersionHash: benchmark.versionHash,
      result: graded.result,
      score: graded.score,
      failureCategory: graded.failureCategory,
      failureLabelSource: graded.failureLabelSource,
      metrics: graded.metrics,
      gradedAt: graded.grade.gradedAt,
    });
    log(
      `${row.benchmarkId} / ${row.arm} / repetition ${row.repetition}: ` +
        `${graded.result}${graded.score === null ? "" : ` (${graded.score.toFixed(4)})`}`,
    );
  });

  return listEvaluationRuns(suiteId);
}

interface RegradedRun {
  grade: GradeEvaluationRunResult;
  metrics: RunMetrics;
  result: RunResult;
  score: number | null;
  failureCategory: GradeEvaluationRunResult["failureCategory"];
  failureLabelSource: FailureLabelSource | null;
}

async function regradeStoredRun(
  row: Awaited<ReturnType<typeof listEvaluationRuns>>[number],
  benchmark: PreparedEvaluationCase,
  runtime: EvaluationRuntime,
  signal: AbortSignal,
): Promise<RegradedRun> {
  if (!row.jobId) {
    const grade = syntheticGrade("errored", "Environment failure", "The run has no job row.");
    return {
      grade,
      metrics: emptyMetrics(),
      result: grade.result,
      score: grade.score,
      failureCategory: grade.failureCategory,
      failureLabelSource: grade.failureLabelSource,
    };
  }

  const job = await getJob(row.jobId);
  if (!job) {
    const grade = syntheticGrade("errored", "Environment failure", "The referenced job is gone.");
    return {
      grade,
      metrics: emptyMetrics(),
      result: grade.result,
      score: grade.score,
      failureCategory: grade.failureCategory,
      failureLabelSource: grade.failureLabelSource,
    };
  }

  return gradeJob(job, benchmark, runtime, signal);
}

async function runEvaluationCell(input: {
  suiteId: string;
  cell: EvaluationMatrixCell;
  runtime: EvaluationRuntime;
  queue: BullJobQueue;
  worker?: ChildProcess;
  waitTimeoutMs?: number;
  signal: AbortSignal;
  log: (message: string) => void;
}): Promise<EvaluationRun> {
  const { cell, runtime, queue, worker, signal } = input;
  let job: JobDetail;

  try {
    job = await createJob({
      title: cell.benchmark.spec.title,
      description: cell.benchmark.spec.issue,
      repoUrl: formatLocalRepoUrl(cell.benchmark.id),
      baseBranch: DEFAULT_BASE_BRANCH,
      reviewMode: cell.arm.jobPatch.reviewMode ?? cell.benchmark.spec.reviewMode,
      maxReviewLoops: cell.arm.jobPatch.maxReviewLoops ?? runtime.config.maxReviewLoops,
      maxDurationSeconds:
        cell.arm.jobPatch.maxDurationSeconds ?? cell.benchmark.spec.maxDurationSeconds,
      maxCostUsd: cell.arm.jobPatch.maxCostUsd ?? cell.benchmark.spec.maxCostUsd,
      maxModelCalls: cell.arm.jobPatch.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS,
      maxToolCalls: cell.arm.jobPatch.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    });
  } catch (error) {
    const grade = syntheticGrade(
      "errored",
      "Environment failure",
      `Could not create the job: ${describeError(error)}`,
    );
    return recordRun({
      suiteId: input.suiteId,
      cell,
      jobId: null,
      caseVersionHash: cell.benchmark.versionHash,
      grade,
      metrics: emptyMetrics(),
    });
  }

  const enqueued = await requestJobRun(job.id, job.dispatchGeneration, queue);
  if (enqueued.result === null) {
    input.log(
      `Could not enqueue job ${job.id}: ${describeError(enqueued.error)}. ` +
        "Waiting for the worker sweeper to reconcile the queued row.",
    );
  }

  const waited = await waitForTerminal(job.id, {
    timeoutMs: input.waitTimeoutMs ?? waitTimeoutFor(job.maxDurationSeconds),
    signal,
    ...(worker ? { worker } : {}),
  });

  if (waited.reason !== "terminal" || !waited.job) {
    await cancelStuckJob(job.id, queue);
    const grade = syntheticGrade(
      "errored",
      "Environment failure",
      `Job ${job.id} did not reach a terminal status (${waited.reason}).`,
    );
    return recordRun({
      suiteId: input.suiteId,
      cell,
      jobId: job.id,
      caseVersionHash: cell.benchmark.versionHash,
      grade,
      metrics: buildMetrics(waited.job ?? job, null, null, null, null),
    });
  }

  try {
    const graded = await gradeJob(waited.job, cell.benchmark, runtime, signal);
    return recordRun({
      suiteId: input.suiteId,
      cell,
      jobId: waited.job.id,
      caseVersionHash: cell.benchmark.versionHash,
      grade: graded.grade,
      metrics: graded.metrics,
    });
  } catch (error) {
    signal.throwIfAborted();
    input.log(`Could not grade ${cell.benchmark.id}: ${describeError(error)}`);
    const grade = syntheticGrade(
      "ungraded",
      "grade_workspace_invalid",
      `The runner could not complete grading: ${describeError(error)}`,
    );
    return recordRun({
      suiteId: input.suiteId,
      cell,
      jobId: waited.job.id,
      caseVersionHash: cell.benchmark.versionHash,
      grade,
      metrics: emptyMetricsFromJob(waited.job),
    });
  }
}

async function gradeJob(
  job: JobDetail,
  benchmark: PreparedEvaluationCase,
  runtime: EvaluationRuntime,
  signal: AbortSignal,
): Promise<RegradedRun> {
  const evidence = await readJobEvidence(job.id);
  const turnCeilingReached = evidence.turnCeilingReached;
  const grade = await gradeEvaluationRun({
    jobId: job.id,
    job: {
      status: job.status,
      failureCategory: job.failureCategory,
      failureReason: job.failureReason,
      reviewDecision: job.reviewDecision,
      turnCeilingReached,
      filesChanged: evidence.diffStat?.filesChanged ?? null,
    },
    validationOutcome: evidence.validationReport?.outcome ?? evidence.validation?.outcome ?? null,
    benchmark: {
      id: benchmark.id,
      repoUrl: formatLocalRepoUrl(benchmark.id),
      baseBranch: DEFAULT_BASE_BRANCH,
      setupCommand: benchmark.spec.setupCommand,
      validationCommand: benchmark.spec.validationCommand,
      hiddenFiles: benchmark.hiddenFiles,
    },
    readCheckpoint: () =>
      getLatestCheckpoint(job.id, { maxBytes: runtime.config.checkpointMaxBytes }),
    seed: runtime.localSeed.seed,
    seedTimeoutMs: runtime.config.eval.cloneTimeoutMs,
    seedMaxBytes: runtime.config.eval.seedMaxBytes,
    sandbox: {
      provider: runtime.sandbox,
      image: runtime.config.sandbox.image,
      workdir: runtime.config.sandbox.workdir,
      memoryBytes: runtime.config.sandbox.memoryBytes,
      nanoCpus: runtime.config.sandbox.nanoCpus,
      pidsLimit: runtime.config.sandbox.pidsLimit,
      commandTimeoutMs: runtime.config.sandbox.commandTimeoutMs,
      validationTimeoutMs: runtime.config.sandbox.checkTimeoutMs,
      maxOutputBytes: runtime.config.sandbox.maxOutputBytes,
      maxPatchBytes: runtime.config.checkpointMaxBytes,
    },
    signal,
  });

  return {
    grade,
    metrics: buildMetrics(
      job,
      evidence.validationReport,
      evidence.validation,
      evidence.diffStat,
      grade.hiddenTests,
    ),
    result: grade.result,
    score: grade.score,
    failureCategory: grade.failureCategory,
    failureLabelSource: grade.failureLabelSource,
  };
}

async function recordRun(input: {
  suiteId: string;
  cell: EvaluationMatrixCell;
  jobId: string | null;
  caseVersionHash: string;
  grade: GradeEvaluationRunResult;
  metrics: RunMetrics;
}): Promise<EvaluationRun> {
  return recordEvaluationRun({
    suiteId: input.suiteId,
    jobId: input.jobId,
    benchmarkId: input.cell.benchmark.id,
    caseVersionHash: input.caseVersionHash,
    arm: input.cell.arm.label,
    repetition: input.cell.repetition,
    result: input.grade.result,
    score: input.grade.score,
    failureCategory: input.grade.failureCategory,
    failureLabelSource: input.grade.failureLabelSource,
    metrics: input.metrics,
    gradedAt: input.grade.gradedAt,
  });
}

interface JobEvidence {
  validationReport: ValidationReport | null;
  validation: ValidationRecord | null;
  diffStat: DiffTotals | null;
  turnCeilingReached: boolean;
}

interface DiffTotals {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

async function readJobEvidence(jobId: string): Promise<JobEvidence> {
  const [validationReport, validation, artifacts, events] = await Promise.all([
    readValidationReport(jobId),
    readValidation(jobId),
    listArtifacts(jobId),
    listEvents(jobId, { limit: 2_000 }),
  ]);

  const diffArtifact = [...artifacts].reverse().find((artifact) => artifact.type === "diff_stat");
  let diffStat = diffArtifact ? diffTotalsFromMetadata(diffArtifact.metadata) : null;
  if (!diffStat && diffArtifact && !diffArtifact.truncated) {
    const artifact = await getArtifact(jobId, diffArtifact.id);
    diffStat = artifact ? parseNumstat(artifact.content) : null;
  }
  diffStat ??= validation?.stat ?? null;

  const turnCeilingReached = events.some(
    (event) =>
      event.type === "agent.budget_exceeded" &&
      event.data !== null &&
      event.data.budget === "turns",
  );

  return { validationReport, validation, diffStat, turnCeilingReached };
}

/** Computes the normative metrics snapshot from job and artifact sources. */
export function buildMetrics(
  job: JobDetail,
  validationReport: ValidationReport | null,
  validation: ValidationRecord | null,
  diffStat: DiffTotals | null,
  hiddenTests: GradeEvaluationRunResult["hiddenTests"],
): RunMetrics {
  let newFailureCount: number | null = null;
  let fixedFailureCount: number | null = null;
  if (validationReport) {
    newFailureCount = 0;
    fixedFailureCount = 0;
    for (const check of validationReport.checks) {
      if (check.kind === "targeted_test" || !check.attribution) continue;
      newFailureCount += check.attribution.newFailures.length;
      fixedFailureCount += check.attribution.fixedFailures.length;
    }
  }

  const reviewDecision = job.reviewDecision ?? null;
  const metrics = {
    runtimeSeconds: runtimeSeconds(job),
    totalModelCalls: job.totalModelCalls,
    totalToolCalls: job.totalToolCalls,
    totalTurns: job.totalTurns,
    totalInputTokens: job.totalInputTokens,
    totalOutputTokens: job.totalOutputTokens,
    totalCostUsd: job.totalCostUsd,
    attemptCount: job.attemptCount,
    reviewLoops: job.reviewLoops,
    reviewDecision,
    reviewBlockingCount: reviewDecision === null ? null : job.reviewBlockingCount,
    validationOutcome: validationReport?.outcome ?? validation?.outcome ?? null,
    newFailureCount,
    fixedFailureCount,
    filesChanged: diffStat?.filesChanged ?? null,
    insertions: diffStat?.insertions ?? null,
    deletions: diffStat?.deletions ?? null,
    hiddenTestsTotal: hiddenTests?.total ?? null,
    hiddenTestsPassed: hiddenTests?.passed ?? null,
  } satisfies RunMetrics;

  return runMetricsSchema.parse(metrics);
}

function emptyMetricsFromJob(job: JobDetail): RunMetrics {
  return buildMetrics(job, null, null, null, null);
}

function emptyMetrics(): RunMetrics {
  return {
    runtimeSeconds: null,
    totalModelCalls: 0,
    totalToolCalls: 0,
    totalTurns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: "0",
    attemptCount: 0,
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
}

function runtimeSeconds(job: JobDetail): number | null {
  if (!job.startedAt || !job.completedAt) return null;
  return Math.max(0, Math.round((job.completedAt.getTime() - job.startedAt.getTime()) / 1_000));
}

function diffTotalsFromMetadata(metadata: Record<string, unknown> | null): DiffTotals | null {
  if (!metadata) return null;
  const filesChanged = countValue(metadata.filesChanged);
  const insertions = countValue(metadata.insertions);
  const deletions = countValue(metadata.deletions);
  if (filesChanged === null || insertions === null || deletions === null) return null;
  return { filesChanged, insertions, deletions };
}

function parseNumstat(content: string): DiffTotals | null {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of content.split(/\r?\n/u)) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const added = numstatValue(fields[0]);
    const removed = numstatValue(fields[1]);
    if (added === undefined || removed === undefined) continue;
    filesChanged += 1;
    if (added !== null) insertions += added;
    if (removed !== null) deletions += removed;
  }
  return filesChanged === 0 && content.trim().length > 0
    ? null
    : { filesChanged, insertions, deletions };
}

function numstatValue(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === "-") return null;
  return /^\d+$/u.test(value) ? Number(value) : undefined;
}

function countValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function syntheticGrade(
  result: RunResult,
  failureCategory: GradeEvaluationRunResult["failureCategory"],
  detail: string,
): GradeEvaluationRunResult {
  const source: FailureLabelSource | null = failureCategory === null ? null : "auto";
  return {
    result,
    score: null,
    failureCategory,
    failureLabelSource: source,
    hiddenTests: null,
    commands: [],
    sandboxId: null,
    gradedAt: new Date(),
    detail,
  };
}

export async function waitForTerminal(
  jobId: string,
  options: {
    timeoutMs: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
    worker?: ChildProcess;
    readJob?: (id: string) => Promise<JobDetail | null>;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<WaitForTerminalResult> {
  const readJob = options.readJob ?? getJob;
  const sleep = options.sleep ?? abortableSleep;
  const signal = options.signal ?? new AbortController().signal;
  const deadline = Date.now() + options.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  for (;;) {
    signal.throwIfAborted();
    const job = await readJob(jobId);
    if (!job) return { job: null, reason: "missing" };
    if (isTerminal(job.status)) return { job, reason: "terminal" };
    if (options.worker && options.worker.exitCode !== null) {
      return { job, reason: "worker_exited" };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { job, reason: "timeout" };
    await sleep(Math.min(pollIntervalMs, remaining), signal);
  }
}

export function waitTimeoutFor(maxDurationSeconds: number): number {
  return Math.max(60_000, maxDurationSeconds * 1_000 + DEFAULT_WAIT_GRACE_MS);
}

async function cancelStuckJob(jobId: string, queue: BullJobQueue): Promise<void> {
  const { requestJobCancellation } = await import("@rivet/core");
  await requestJobCancellation(jobId, queue).catch(() => undefined);
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const next = { index: 0 };
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    async () => {
      for (;;) {
        const index = next.index;
        next.index += 1;
        const item = items[index];
        if (item === undefined) return;
        await run(item);
      }
    },
  );
  await Promise.all(workers);
}

function resolveConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw new Error(`Evaluation concurrency must be an integer from 1 to ${MAX_CONCURRENCY}.`);
  }
  return value;
}

/** Starts a real worker for a matrix, mirroring the existing job demo. */
export function startEvaluationWorker(repositoryRoot: string, concurrency: number): ChildProcess {
  const child = spawn(CHILD_WORKER_COMMAND, ["--filter", "@rivet/worker", "start"], {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      RIVET_EVAL: "on",
      RIVET_GITHUB: "off",
      RIVET_SANDBOX: process.env.RIVET_SANDBOX ?? "docker",
      RIVET_AGENT: process.env.RIVET_AGENT ?? "pi",
      WORKER_CONCURRENCY: String(
        Math.max(concurrency, parseInteger(process.env.WORKER_CONCURRENCY) ?? concurrency),
      ),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.once("error", (error) => console.error(`[evaluation worker] ${error.message}`));
  return child;
}

export async function stopEvaluationWorker(worker: ChildProcess | undefined): Promise<void> {
  if (worker?.exitCode !== null) return;

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

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal ? abortReason(signal) : new Error("Evaluation sleep aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

function parseInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ParsedEvalRunArgs {
  dryRun: boolean;
  demo: boolean;
  suiteFile: string | null;
  caseIds: string[] | null;
  label: string | null;
  repetitions: number | null;
  concurrency: number | null;
  noWorker: boolean;
  waitTimeoutMs: number | null;
}

function parseEvalRunArgs(argv: readonly string[]): ParsedEvalRunArgs {
  const parsed: ParsedEvalRunArgs = {
    dryRun: false,
    demo: false,
    suiteFile: null,
    caseIds: null,
    label: null,
    repetitions: null,
    concurrency: null,
    noWorker: false,
    waitTimeoutMs: null,
  };
  const cases: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--dry-run") {
      parsed.dryRun = true;
    } else if (argument === "--demo") {
      parsed.demo = true;
    } else if (argument === "--no-worker") {
      parsed.noWorker = true;
    } else if (argument === "--help" || argument === "-h") {
      printEvalRunHelp();
      process.exitCode = 0;
      return parsed;
    } else if (argument === "--suite-file" || argument === "--suite") {
      parsed.suiteFile = requireArg(argv, ++index, argument);
    } else if (argument === "--cases" || argument === "--case") {
      cases.push(...requireArg(argv, ++index, argument).split(",").filter(Boolean));
    } else if (argument === "--label") {
      parsed.label = requireArg(argv, ++index, argument);
    } else if (argument === "--repetitions") {
      parsed.repetitions = positiveArg(requireArg(argv, ++index, argument), argument);
    } else if (argument === "--concurrency") {
      parsed.concurrency = resolveConcurrency(
        positiveArg(requireArg(argv, ++index, argument), argument),
      );
    } else if (argument === "--wait-timeout-ms") {
      parsed.waitTimeoutMs = positiveArg(requireArg(argv, ++index, argument), argument);
    } else if (!argument.startsWith("-") && parsed.suiteFile === null) {
      parsed.suiteFile = argument;
    } else {
      throw new Error(`Unknown eval:run argument ${argument}.`);
    }
  }

  parsed.caseIds = cases.length > 0 ? cases : null;
  return parsed;
}

function requireArg(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} needs a value.`);
  return value;
}

function positiveArg(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} needs a positive integer.`);
  }
  return parsed;
}

async function readSuiteFile(path: string): Promise<EvaluationSuite> {
  const raw = await readFile(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Could not parse evaluation suite ${path}: ${describeError(error)}.`, {
      cause: error,
    });
  }
  return evaluationSuiteSchema.parse(value);
}

function createDefaultSuite(caseIds: readonly string[]): EvaluationSuite {
  return evaluationSuiteSchema.parse({
    label: DEFAULT_SUITE_LABEL,
    arms: DEFAULT_ARMS,
    repetitions: 3,
    caseIds: [...caseIds],
  });
}

function applySuiteOverrides(
  suite: EvaluationSuite,
  options: ParsedEvalRunArgs,
  defaultCaseIds: readonly string[],
): EvaluationSuite {
  return evaluationSuiteSchema.parse({
    ...suite,
    ...(options.label === null ? {} : { label: options.label }),
    ...(options.repetitions === null ? {} : { repetitions: options.repetitions }),
    ...(options.caseIds === null ? {} : { caseIds: options.caseIds }),
    ...(suite.caseIds.length > 0 ? {} : { caseIds: [...defaultCaseIds] }),
  });
}

function assertDemoEvaluationConfiguration(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("pnpm demo:eval cannot run with NODE_ENV=production.");
  }
  if (process.env.RIVET_SANDBOX === "off") {
    throw new Error("pnpm demo:eval needs RIVET_SANDBOX=docker so it can grade real workspaces.");
  }
  if (process.env.RIVET_AGENT === "off" || process.env.RIVET_AGENT === "scripted") {
    throw new Error("pnpm demo:eval needs RIVET_AGENT=pi for a real model evaluation.");
  }

  const provider = process.env.RIVET_MODEL_PROVIDER ?? DEFAULT_MODEL_PROVIDER;
  if (provider === DEFAULT_MODEL_PROVIDER && !process.env.OPENROUTER_API_KEY) {
    throw new Error(
      `OPENROUTER_API_KEY is required for pnpm demo:eval with ${DEFAULT_MODEL}. ` +
        "Put it in .env.local or export it first.",
    );
  }
}

function printEvalRunHelp(): void {
  console.log(`Usage: pnpm eval:run [options]

Options:
  --dry-run                 Print the matrix without touching Postgres, Redis or Docker.
  --demo                    Require Docker and real model credentials.
  --suite-file <path>       Read a strict evaluation suite JSON definition.
  --cases <a,b,...>         Select benchmark cases (repeatable).
  --label <label>           Override the suite label.
  --repetitions <n>         Override the repetition count.
  --concurrency <n>         Override RIVET_EVAL_CONCURRENCY.
  --wait-timeout-ms <n>     Bound one job wait, including its configured job budget.
  --no-worker               Use an already-running worker instead of starting one.
`);
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseEvalRunArgs(process.argv.slice(2));
  if (process.exitCode !== undefined) return;
  if (args.demo) assertDemoEvaluationConfiguration();

  const repositoryRoot = findRepositoryRoot();
  const benchmarkRoot = resolveRoot(
    process.env.RIVET_BENCHMARK_ROOT ?? DEFAULT_BENCHMARK_ROOT,
    repositoryRoot,
  );
  const allCases = await loadBenchmarkCases(benchmarkRoot);
  const suiteFromFile = args.suiteFile ? await readSuiteFile(args.suiteFile) : null;
  const defaultCaseIds = allCases.map((benchmark) => benchmark.id);
  const selectedIds = args.caseIds ?? suiteFromFile?.caseIds ?? defaultCaseIds;
  const suite = applySuiteOverrides(
    suiteFromFile ?? createDefaultSuite(selectedIds),
    args,
    defaultCaseIds,
  );
  const benchmarks = await prepareEvaluationCases(benchmarkRoot, suite);

  if (args.dryRun) {
    process.stdout.write(formatEvaluationMatrix(suite, benchmarks));
    return;
  }

  const runtimeConfig = parseEvaluationRuntimeConfig(process.env);
  if (runtimeConfig.sandbox.mode !== "docker") {
    throw new Error(
      "pnpm eval:run needs RIVET_SANDBOX=docker so the jobs and grader use real containers.",
    );
  }
  const fixtureRoot = resolveRoot(
    process.env.RIVET_BENCHMARK_FIXTURE_ROOT ?? DEFAULT_BENCHMARK_FIXTURE_ROOT,
    repositoryRoot,
  );
  const prepared = await prepareEvaluationCases(benchmarkRoot, suite, {
    fixtureRoot,
    requireBuiltRepositories: true,
  });
  const localSeed = createLocalSeedOptions(
    { ...runtimeConfig.eval, mode: "on" },
    { repositoryRoot },
  );
  if (!localSeed) throw new Error("Could not configure the local benchmark seed source.");

  const runtime: EvaluationRuntime = {
    config: runtimeConfig,
    sandbox: new DockerSandboxProvider({ workerId: `rivet-eval-${process.pid}` }),
    localSeed,
  };
  const queue = getBullJobQueue();
  const concurrency = args.concurrency ?? runtimeConfig.eval.concurrency;
  const abortController = new AbortController();
  const onSignal = () => abortController.abort(new Error("Evaluation runner interrupted."));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let worker: ChildProcess | undefined;

  try {
    worker = args.noWorker ? undefined : startEvaluationWorker(repositoryRoot, concurrency);
    const result = await runEvaluationSuite({
      suite,
      benchmarks: prepared,
      runtime,
      queue,
      repositoryRoot,
      ...(worker ? { worker, startWorker: false } : { startWorker: false }),
      concurrency,
      ...(args.waitTimeoutMs === null ? {} : { waitTimeoutMs: args.waitTimeoutMs }),
      signal: abortController.signal,
    });
    console.log(`Evaluation suite completed: ${result.suiteId}`);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await stopEvaluationWorker(worker);
    await closeJobQueue();
    await closeRedis();
    await closeDb();
  }
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
