import type { EvaluationFailureCategory, RunResult } from "@rivet/contracts";

/**
 * Presentation metadata for the evaluation surface.
 *
 * No database and no Next import, for the same reason `job-status.ts` has
 * neither: the tables, the badges and the unit tests all read one copy. The
 * arithmetic these labels wrap lives in `@rivet/core`'s evaluation aggregate
 * module - nothing here computes a number, it only says how one is written
 * down.
 */
export interface ResultPresentation {
  label: string;
  className: string;
  /** Whether the outcome counts toward the success-rate denominator. */
  graded: boolean;
}

/**
 * A total record over `RunResult`, so a fifth outcome breaks typecheck here
 * until somebody decides how it reads and whether it is graded.
 */
export const RUN_RESULT_PRESENTATION: Record<RunResult, ResultPresentation> = {
  passed: {
    label: "Passed",
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    graded: true,
  },
  failed: {
    label: "Failed",
    className: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
    graded: true,
  },
  errored: {
    label: "Errored",
    className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    graded: false,
  },
  ungraded: {
    label: "Ungraded",
    className: "border-border bg-muted text-muted-foreground",
    graded: false,
  },
};

/** The label a `null` §24.5 category is shown under, never a hidden row. */
export const UNLABELED_FAILURE_LABEL = "Unlabelled";

export function formatFailureLabel(label: EvaluationFailureCategory | null): string {
  if (label === null) return UNLABELED_FAILURE_LABEL;
  return label === "grade_workspace_invalid" ? "Grading workspace invalid" : label;
}

/**
 * `0.5` -> `"50%"`.
 *
 * A null rate means nothing in the group could be graded, which is a different
 * statement from 0% and is written as one.
 */
export function formatSuccessRate(rate: number | null): string {
  if (rate === null) return "n/a";
  return `${(rate * 100).toFixed(rate === 0 || rate === 1 ? 0 : 1)}%`;
}

/** `1` -> `"1.00"`, keeping a near-miss visible instead of rounding it away. */
export function formatScore(score: number | null): string {
  return score === null ? "-" : score.toFixed(2);
}

/** `passed`/`graded`, with the ungradable runs named rather than folded in. */
export function formatSuccessFraction(counts: {
  passed: number;
  graded: number;
  total: number;
}): string {
  const fraction = `${String(counts.passed)}/${String(counts.graded)}`;
  const excluded = counts.total - counts.graded;
  return excluded === 0 ? fraction : `${fraction} (+${String(excluded)} not graded)`;
}

/** `[0.25, 1]` -> `"0.25-1.00"`; a single value prints once. */
export function formatScoreSpread(min: number | null, max: number | null): string {
  if (min === null || max === null) return "-";
  return min === max ? formatScore(min) : `${formatScore(min)}-${formatScore(max)}`;
}

/** Seconds with one decimal below a minute, whole minutes above. */
export function formatRuntimeSeconds(seconds: number | null): string {
  if (seconds === null) return "n/a";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(remainder)}s`;
}

/** Suite lifecycle colours, a total record over the store's status union. */
export const SUITE_STATUS_PRESENTATION: Record<string, string> = {
  running: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  completed: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  aborted: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
};

export function suiteStatusClassName(status: string): string {
  return SUITE_STATUS_PRESENTATION[status] ?? "border-border bg-muted text-muted-foreground";
}

/** `bug_fix` -> `Bug fix`, for the §24.1 category column. */
export function formatCategory(category: string): string {
  const spaced = category.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
