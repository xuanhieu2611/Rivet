import type { CheckKind, CheckStatus, ValidationOutcome } from "@rivet/contracts";

export const VALIDATION_OUTCOME_PRESENTATION: Record<
  ValidationOutcome,
  { label: string; className: string; textClassName: string; tone: string }
> = {
  verified: {
    label: "Verified",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    textClassName: "text-emerald-700 dark:text-emerald-300",
    tone: "bg-emerald-500",
  },
  fixed: {
    label: "Fixed",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    textClassName: "text-emerald-700 dark:text-emerald-300",
    tone: "bg-emerald-500",
  },
  regressed: {
    label: "Regressed",
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    textClassName: "text-red-700 dark:text-red-300",
    tone: "bg-red-500",
  },
  unresolved: {
    label: "Unresolved",
    className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    textClassName: "text-red-700 dark:text-red-300",
    tone: "bg-red-500",
  },
  unverified: {
    label: "Unverified",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    textClassName: "text-amber-700 dark:text-amber-300",
    tone: "bg-amber-500",
  },
};

export const CHECK_KIND_LABELS: Record<CheckKind, string> = {
  targeted_test: "Targeted tests",
  test: "Full test suite",
  typecheck: "Typecheck",
  lint: "Lint",
};

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}
