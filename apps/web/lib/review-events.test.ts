import type { JobEvent, JobEventData, JobEventType } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { describeReviewEvent, isReviewEvent } from "@/lib/review-events";

function event(type: JobEventType, data: JobEventData | null, message = "message"): JobEvent {
  return {
    id: 1,
    jobId: "11111111-1111-4111-8111-111111111111",
    type,
    message,
    data,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("isReviewEvent", () => {
  it("recognizes all independent-review events", () => {
    for (const type of [
      "review.recorded",
      "review.revision_requested",
      "review.limit_reached",
      "review.skipped",
    ] as const) {
      expect(isReviewEvent(event(type, null))).toBe(true);
    }
  });

  it("leaves unrelated timeline events alone", () => {
    expect(isReviewEvent(event("phase.started", { phase: "reviewing" }))).toBe(false);
    expect(describeReviewEvent(event("phase.started", { phase: "reviewing" }))).toBeNull();
  });
});

describe("describeReviewEvent", () => {
  it("shows the verdict, confidence, findings and artifact", () => {
    const presentation = describeReviewEvent(
      event("review.recorded", {
        artifactId: 42,
        reviewDecision: "approve",
        reviewLoop: 1,
        blockingCount: 0,
        nonBlockingCount: 2,
        confidence: 0.9,
      }),
    );

    expect(presentation).toEqual({
      label: "Approved",
      emphasis: "positive",
      explanation:
        "An independent, read-only reviewer inspected the patch and persisted a structured verdict.",
      facts: [
        "review 2",
        "90% confidence",
        "0 blocking findings",
        "2 non-blocking findings",
        "artifact #42",
      ],
    });
  });

  it("makes the loop visible between review and the next test run", () => {
    const presentation = describeReviewEvent(
      event("review.revision_requested", {
        reviewLoop: 0,
        reviewLoops: 1,
        maxReviewLoops: 2,
        blockingCount: 1,
      }),
    );

    expect(presentation?.label).toBe("Revision requested");
    expect(presentation?.facts).toEqual(["revision loops: 1/2", "1 blocking finding"]);
    expect(presentation?.explanation).toContain("another independent review");
  });

  it("explains why an exhausted review fails the job", () => {
    const presentation = describeReviewEvent(
      event("review.limit_reached", {
        reviewLoops: 2,
        maxReviewLoops: 2,
        blockingCount: 3,
        failureCategory: "reviewer_rejection",
      }),
    );

    expect(presentation?.emphasis).toBe("negative");
    expect(presentation?.facts).toEqual([
      "revision loops: 2/2",
      "3 blocking findings",
      "Rejected by review",
    ]);
  });

  it("distinguishes an opted-out review from a missing verdict", () => {
    const presentation = describeReviewEvent(event("review.skipped", { reviewMode: "none" }));

    expect(presentation?.label).toBe("Review skipped");
    expect(presentation?.facts).toEqual(["mode: none"]);
    expect(presentation?.explanation).toContain("without starting");
  });
});
