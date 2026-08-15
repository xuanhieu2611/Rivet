import type { JobEvent, JobEventType } from "@rivet/contracts";

import { FAILURE_CATEGORY_LABELS } from "@/lib/job-status";

/** The structured presentation used for the four independent-review events. */
export interface ReviewEventPresentation {
  label: string;
  emphasis: "neutral" | "positive" | "negative";
  explanation: string;
  facts: readonly string[];
}

export const REVIEW_EVENT_TYPES = [
  "review.recorded",
  "review.revision_requested",
  "review.limit_reached",
  "review.skipped",
] as const satisfies readonly JobEventType[];

const REVIEW_EVENT_TYPE_SET: ReadonlySet<string> = new Set(REVIEW_EVENT_TYPES);

export function isReviewEvent(event: JobEvent): boolean {
  return REVIEW_EVENT_TYPE_SET.has(event.type);
}

export function describeReviewEvent(event: JobEvent): ReviewEventPresentation | null {
  switch (event.type) {
    case "review.recorded":
      return describeReviewRecorded(event);
    case "review.revision_requested":
      return describeRevisionRequested(event);
    case "review.limit_reached":
      return describeLimitReached(event);
    case "review.skipped":
      return describeReviewSkipped(event);
    default:
      return null;
  }
}

function describeReviewRecorded(event: JobEvent): ReviewEventPresentation {
  const data = event.data;
  const decision = data?.reviewDecision;

  return {
    label:
      decision === "approve"
        ? "Approved"
        : decision === "revise"
          ? "Revision requested"
          : "Review verdict",
    emphasis: decision === "approve" ? "positive" : "neutral",
    explanation:
      "An independent, read-only reviewer inspected the patch and persisted a structured verdict.",
    facts: compact([
      data?.reviewLoop === undefined ? null : `review ${String(data.reviewLoop + 1)}`,
      data?.confidence === undefined
        ? null
        : `${String(Math.round(data.confidence * 100))}% confidence`,
      countFact(data?.blockingCount, "blocking finding"),
      countFact(data?.nonBlockingCount, "non-blocking finding"),
      data?.artifactId === undefined ? null : `artifact #${String(data.artifactId)}`,
    ]),
  };
}

function describeRevisionRequested(event: JobEvent): ReviewEventPresentation {
  const data = event.data;

  return {
    label: "Revision requested",
    emphasis: "neutral",
    explanation:
      "A blocking finding remains, so Rivet sends the patch through revision, validation and another independent review.",
    facts: compact([
      reviewLoopFact(data?.reviewLoops, data?.maxReviewLoops),
      countFact(data?.blockingCount, "blocking finding"),
    ]),
  };
}

function describeLimitReached(event: JobEvent): ReviewEventPresentation {
  const data = event.data;

  return {
    label: "Review limit reached",
    emphasis: "negative",
    explanation:
      "The last review still found blocking issues after Rivet's revision budget was exhausted, so the job stops instead of finalizing a rejected patch.",
    facts: compact([
      reviewLoopFact(data?.reviewLoops, data?.maxReviewLoops),
      countFact(data?.blockingCount, "blocking finding"),
      data?.failureCategory ? FAILURE_CATEGORY_LABELS[data.failureCategory] : null,
    ]),
  };
}

function describeReviewSkipped(event: JobEvent): ReviewEventPresentation {
  return {
    label: "Review skipped",
    emphasis: "neutral",
    explanation:
      "This job selected reviewMode: none, so the workflow continued without starting an independent reviewer session.",
    facts: compact([event.data?.reviewMode ? `mode: ${event.data.reviewMode}` : null]),
  };
}

function reviewLoopFact(
  reviewLoops: number | undefined,
  maxReviewLoops: number | undefined,
): string | null {
  if (reviewLoops === undefined) return null;
  return maxReviewLoops === undefined
    ? `revision loops: ${String(reviewLoops)}`
    : `revision loops: ${String(reviewLoops)}/${String(maxReviewLoops)}`;
}

function countFact(count: number | undefined, noun: string): string | null {
  if (count === undefined) return null;
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function compact(values: readonly (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null && value.length > 0);
}
