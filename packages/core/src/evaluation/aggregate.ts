import {
  EVALUATION_FAILURE_CATEGORIES,
  FAILURE_LABELS,
  type BenchmarkCategory,
  type EvaluationFailureCategory,
  type FailureLabelSource,
  type RunMetrics,
  type RunResult,
} from "@rivet/contracts";

/**
 * The evaluation aggregates the dashboard renders.
 *
 * This module is deliberately pure and lives in core rather than in the web
 * app: the numbers a reader judges the system by are domain arithmetic, not
 * presentation, and they have to be unit-testable without Next, Postgres or a
 * browser. Every function here takes rows and returns numbers; nothing reads
 * the database, and nothing formats a string for display.
 *
 * The one rule that governs all of it comes from PRD §24.3 by way of the M10
 * acceptance contract: **success rate is computed over `passed + failed`
 * only**. `errored` (Rivet or its environment broke) and `ungraded` (grading
 * itself broke) are counted, reported and excluded from the denominator,
 * because averaging an infrastructure failure rate into a task failure rate
 * hides both numbers.
 */

/** The minimum a run must expose to be aggregated. `EvaluationRunRecord` satisfies it. */
export interface AggregatableEvaluationRun {
  benchmarkId: string;
  arm: string;
  repetition: number;
  result: RunResult;
  score: number | null;
  failureCategory: EvaluationFailureCategory | null;
  failureLabelSource: FailureLabelSource | null;
  metrics: RunMetrics;
}

/** One outcome tally plus the success rate derived from the graded subset. */
export interface EvaluationOutcomeCounts {
  passed: number;
  failed: number;
  errored: number;
  ungraded: number;
  /** Every run in the group, including the ones excluded from `successRate`. */
  total: number;
  /** `passed + failed` - the success-rate denominator. */
  graded: number;
  /** `passed / graded`, or null when nothing in the group could be graded. */
  successRate: number | null;
}

/** A tally for one arm, case or category, keyed by that group's identity. */
export interface EvaluationGroupSummary {
  key: string;
  counts: EvaluationOutcomeCounts;
  /** Mean hidden-test score over graded runs, so a near-miss stays visible. */
  meanScore: number | null;
}

/** One (case, arm) cell of the matrix, with its repetition spread intact. */
export interface EvaluationMatrixCell {
  benchmarkId: string;
  arm: string;
  counts: EvaluationOutcomeCounts;
  /** Every graded run's score, in repetition order. */
  scores: number[];
  minScore: number | null;
  maxScore: number | null;
}

/** The §24.4 efficiency family, summed and averaged over the whole group. */
export interface EvaluationEfficiencySummary {
  runCount: number;
  medianRuntimeSeconds: number | null;
  meanRuntimeSeconds: number | null;
  totalCostUsd: string;
  meanCostUsd: string;
  totalModelCalls: number;
  totalToolCalls: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalAttempts: number;
}

/** The §24.4 quality family, derived from the stored metric snapshots. */
export interface EvaluationQualitySummary {
  /** Runs whose validation aggregate was `regressed`. */
  regressedRuns: number;
  newFailureTotal: number;
  fixedFailureTotal: number;
  meanFilesChanged: number | null;
  meanInsertions: number | null;
  meanDeletions: number | null;
  reviewApproved: number;
  reviewRevised: number;
  reviewAbsent: number;
  meanReviewLoops: number | null;
  hiddenTestsPassed: number;
  hiddenTestsTotal: number;
}

/** One bar of the §24.5 histogram. A `null` label is the unlabelled bucket. */
export interface EvaluationFailureBucket {
  label: EvaluationFailureCategory | null;
  auto: number;
  manual: number;
  total: number;
}

/** Everything `/evaluations/:id` renders, computed in one pass over the rows. */
export interface EvaluationSuiteSummary {
  overall: EvaluationOutcomeCounts;
  byArm: EvaluationGroupSummary[];
  byCase: EvaluationGroupSummary[];
  byCategory: EvaluationGroupSummary[];
  arms: string[];
  benchmarkIds: string[];
  matrix: EvaluationMatrixCell[];
  efficiency: EvaluationEfficiencySummary;
  quality: EvaluationQualitySummary;
  failures: EvaluationFailureBucket[];
  /** Non-passed runs carrying no §24.5 label, shown rather than hidden. */
  unlabeledFailures: number;
}

/** The bucket key for a run whose case is not in the registry snapshot. */
export const UNCATEGORIZED_KEY = "uncategorized";

export interface SummarizeEvaluationRunsOptions {
  /** `benchmarkId` -> §24.1 category, normally from the `benchmark_cases` registry. */
  categories?: Readonly<Record<string, BenchmarkCategory>>;
}

/** Tallies outcomes and derives the graded-only success rate. */
export function countEvaluationOutcomes(
  runs: readonly AggregatableEvaluationRun[],
): EvaluationOutcomeCounts {
  const counts = { passed: 0, failed: 0, errored: 0, ungraded: 0 };
  for (const run of runs) counts[run.result] += 1;

  const graded = counts.passed + counts.failed;
  return {
    ...counts,
    total: runs.length,
    graded,
    successRate: graded === 0 ? null : counts.passed / graded,
  };
}

/**
 * Computes every aggregate the suite page shows.
 *
 * Group ordering is deterministic so two renders of the same suite - and a
 * hand-computed table checked against it, which is what acceptance run H does -
 * compare line by line: arms keep their suite order of first appearance, cases
 * and categories sort by id.
 */
export function summarizeEvaluationRuns(
  runs: readonly AggregatableEvaluationRun[],
  options: SummarizeEvaluationRunsOptions = {},
): EvaluationSuiteSummary {
  const categories = options.categories ?? {};

  const arms = distinct(runs.map((run) => run.arm));
  const benchmarkIds = distinct(runs.map((run) => run.benchmarkId)).sort((a, b) =>
    a.localeCompare(b),
  );
  const categoryKeys = distinct(
    runs.map((run) => categories[run.benchmarkId] ?? UNCATEGORIZED_KEY),
  ).sort((a, b) => a.localeCompare(b));

  const matrix: EvaluationMatrixCell[] = [];
  for (const benchmarkId of benchmarkIds) {
    for (const arm of arms) {
      const cellRuns = runs
        .filter((run) => run.benchmarkId === benchmarkId && run.arm === arm)
        .slice()
        .sort((a, b) => a.repetition - b.repetition);
      if (cellRuns.length === 0) continue;

      const scores = cellRuns
        .map((run) => run.score)
        .filter((score): score is number => score !== null);
      matrix.push({
        benchmarkId,
        arm,
        counts: countEvaluationOutcomes(cellRuns),
        scores,
        minScore: scores.length === 0 ? null : Math.min(...scores),
        maxScore: scores.length === 0 ? null : Math.max(...scores),
      });
    }
  }

  const failed = runs.filter((run) => run.result !== "passed");

  return {
    overall: countEvaluationOutcomes(runs),
    byArm: arms.map((arm) =>
      group(
        arm,
        runs.filter((run) => run.arm === arm),
      ),
    ),
    byCase: benchmarkIds.map((benchmarkId) =>
      group(
        benchmarkId,
        runs.filter((run) => run.benchmarkId === benchmarkId),
      ),
    ),
    byCategory: categoryKeys.map((key) =>
      group(
        key,
        runs.filter((run) => (categories[run.benchmarkId] ?? UNCATEGORIZED_KEY) === key),
      ),
    ),
    arms,
    benchmarkIds,
    matrix,
    efficiency: summarizeEvaluationEfficiency(runs),
    quality: summarizeEvaluationQuality(runs),
    failures: summarizeEvaluationFailures(runs),
    unlabeledFailures: failed.filter((run) => run.failureCategory === null).length,
  };
}

/**
 * Sums the §24.4 efficiency family.
 *
 * Cost is summed as a float and re-formatted to four decimals, matching how
 * `AgentSession` accumulates and persists `jobs.total_cost_usd` in the first
 * place. Introducing a more precise arithmetic here would produce totals that
 * disagree with the job rows they were derived from, which is a worse failure
 * than the rounding it would avoid.
 */
export function summarizeEvaluationEfficiency(
  runs: readonly AggregatableEvaluationRun[],
): EvaluationEfficiencySummary {
  const runtimes = runs
    .map((run) => run.metrics.runtimeSeconds)
    .filter((seconds): seconds is number => seconds !== null);
  const totalCost = runs.reduce((total, run) => total + Number(run.metrics.totalCostUsd), 0);

  return {
    runCount: runs.length,
    medianRuntimeSeconds: median(runtimes),
    meanRuntimeSeconds: mean(runtimes),
    totalCostUsd: totalCost.toFixed(4),
    meanCostUsd: (runs.length === 0 ? 0 : totalCost / runs.length).toFixed(4),
    totalModelCalls: sum(runs, (run) => run.metrics.totalModelCalls),
    totalToolCalls: sum(runs, (run) => run.metrics.totalToolCalls),
    totalTurns: sum(runs, (run) => run.metrics.totalTurns),
    totalInputTokens: sum(runs, (run) => run.metrics.totalInputTokens),
    totalOutputTokens: sum(runs, (run) => run.metrics.totalOutputTokens),
    totalAttempts: sum(runs, (run) => run.metrics.attemptCount),
  };
}

/**
 * Sums the §24.4 quality family.
 *
 * Nullable metric fields mean the job produced no such artifact, so they are
 * skipped rather than counted as zero: a run with no diff stat did not change
 * zero files, it never got far enough to have a diff.
 */
export function summarizeEvaluationQuality(
  runs: readonly AggregatableEvaluationRun[],
): EvaluationQualitySummary {
  const filesChanged = present(runs, (run) => run.metrics.filesChanged);
  const insertions = present(runs, (run) => run.metrics.insertions);
  const deletions = present(runs, (run) => run.metrics.deletions);
  const reviewed = runs.filter((run) => run.metrics.reviewDecision !== null);

  return {
    regressedRuns: runs.filter((run) => run.metrics.validationOutcome === "regressed").length,
    newFailureTotal: sum(runs, (run) => run.metrics.newFailureCount ?? 0),
    fixedFailureTotal: sum(runs, (run) => run.metrics.fixedFailureCount ?? 0),
    meanFilesChanged: mean(filesChanged),
    meanInsertions: mean(insertions),
    meanDeletions: mean(deletions),
    reviewApproved: runs.filter((run) => run.metrics.reviewDecision === "approve").length,
    reviewRevised: runs.filter((run) => run.metrics.reviewDecision === "revise").length,
    reviewAbsent: runs.length - reviewed.length,
    meanReviewLoops: mean(reviewed.map((run) => run.metrics.reviewLoops)),
    hiddenTestsPassed: sum(runs, (run) => run.metrics.hiddenTestsPassed ?? 0),
    hiddenTestsTotal: sum(runs, (run) => run.metrics.hiddenTestsTotal ?? 0),
  };
}

/**
 * Builds the §24.5 histogram over every run that did not pass.
 *
 * The unlabelled bucket is a first-class bar rather than an omission. Half the
 * taxonomy is not machine-decidable, so a histogram that quietly dropped the
 * runs nobody has labelled yet would overstate how much of the failure surface
 * is understood.
 */
export function summarizeEvaluationFailures(
  runs: readonly AggregatableEvaluationRun[],
): EvaluationFailureBucket[] {
  const order: (EvaluationFailureCategory | null)[] = [
    ...FAILURE_LABELS,
    ...EVALUATION_FAILURE_CATEGORIES,
    null,
  ];

  return order
    .map((label) => {
      const matching = runs.filter(
        (run) => run.result !== "passed" && run.failureCategory === label,
      );
      return {
        label,
        auto: matching.filter((run) => run.failureLabelSource === "auto").length,
        manual: matching.filter((run) => run.failureLabelSource === "manual").length,
        total: matching.length,
      };
    })
    .filter((bucket) => bucket.total > 0)
    .slice()
    .sort((a, b) => b.total - a.total || order.indexOf(a.label) - order.indexOf(b.label));
}

function group(key: string, runs: readonly AggregatableEvaluationRun[]): EvaluationGroupSummary {
  const scores = runs.map((run) => run.score).filter((score): score is number => score !== null);
  return { key, counts: countEvaluationOutcomes(runs), meanScore: mean(scores) };
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sum(
  runs: readonly AggregatableEvaluationRun[],
  select: (run: AggregatableEvaluationRun) => number,
): number {
  return runs.reduce((total, run) => total + select(run), 0);
}

function present(
  runs: readonly AggregatableEvaluationRun[],
  select: (run: AggregatableEvaluationRun) => number | null,
): number[] {
  return runs.map(select).filter((value): value is number => value !== null);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Even-length medians average the middle pair, the usual convention. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  return lower === undefined || upper === undefined ? null : (lower + upper) / 2;
}
