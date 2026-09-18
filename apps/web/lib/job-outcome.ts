import type { FailureCategory, JobStatus } from "@rivet/contracts";

import { FAILURE_CATEGORY_LABELS } from "./job-status";

export type JobOutcomeTone = "positive" | "negative" | "neutral";

export interface JobOutcome {
  tone: JobOutcomeTone;
  /** The headline: did it work. */
  headline: string;
  /** One sentence of why, or what to do about it. */
  detail: string;
}

interface OutcomeInput {
  status: JobStatus;
  failureCategory: FailureCategory | null;
  pullRequestUrl: string | null;
  failureReason: string | null;
}

/**
 * What became of a run, in the words a reader wants first.
 *
 * Only ever called for a terminal job. The split between headline and detail is
 * deliberate: a job that completed without publishing anything is still a
 * success, and a job that failed for `github_unavailable` failed at a different
 * place than one that failed for `validation_failed`. Collapsing the two into a
 * single sentence loses the distinction the failure taxonomy exists to make.
 */
export function describeJobOutcome(job: OutcomeInput): JobOutcome {
  switch (job.status) {
    case "completed":
      return {
        tone: "positive",
        headline: "This job succeeded.",
        detail: job.pullRequestUrl
          ? "Validation and review passed, and the change is open as a pull request."
          : "Validation and review passed. Nothing was published, so the change lives in this run's artifacts.",
      };

    case "cancelled":
      return {
        tone: "neutral",
        headline: "This job was cancelled.",
        detail: "A cancel was requested and the worker stopped between phases.",
      };

    case "budget_exceeded":
      return {
        tone: "negative",
        headline: "This job ran out of budget.",
        detail:
          "A model, tool, token or cost ceiling was reached before the run finished. The budgets are under Run metadata.",
      };

    case "timed_out":
      return {
        tone: "negative",
        headline: "This job ran out of time.",
        detail:
          "The wall-clock deadline is fixed at the first claim and survives a reclaim, so downtime counts against it.",
      };

    default:
      return {
        tone: "negative",
        headline: "This job failed.",
        detail: failureDetail(job),
      };
  }
}

function failureDetail(job: OutcomeInput): string {
  const category = job.failureCategory
    ? `${FAILURE_CATEGORY_LABELS[job.failureCategory]}.`
    : "No failure category was recorded.";
  const reason = job.failureReason?.trim();
  return reason ? `${category} ${reason}` : category;
}
