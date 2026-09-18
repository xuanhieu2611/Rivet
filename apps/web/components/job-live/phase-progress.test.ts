import type { JobEvent, JobEventData, JobEventType, JobStatus } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  derivePhaseProgress,
  pipelinePhaseIndex,
  PIPELINE_PHASES,
  type PhaseSegmentState,
} from "./phase-progress";

let nextId = 0;

function event(type: JobEventType, data: JobEventData = {}): JobEvent {
  nextId += 1;
  return {
    id: nextId,
    jobId: "00000000-0000-4000-8000-000000000000",
    type,
    message: type,
    data,
    createdAt: new Date(nextId * 1_000),
  };
}

/** The event pair the worker writes around every phase, in the same order. */
function phase(
  label: string,
  from: JobStatus,
  to: JobStatus,
  durationMs: number,
): readonly JobEvent[] {
  return [
    event("phase.started", { phase: label, from, to }),
    event("phase.completed", { phase: label, durationMs }),
  ];
}

function states(events: readonly JobEvent[], status: JobStatus): PhaseSegmentState[] {
  return derivePhaseProgress(events, status).segments.map((segment) => segment.state);
}

describe("derivePhaseProgress", () => {
  it("has one segment per pipeline phase, in walk order", () => {
    const progress = derivePhaseProgress([], "queued");

    expect(progress.segments.map((segment) => segment.status)).toEqual([...PIPELINE_PHASES]);
    expect(progress.segments.every((segment) => segment.state === "pending")).toBe(true);
    expect(progress.activePhase).toBeNull();
    expect(progress.completedCount).toBe(0);
    expect(progress.totalDurationMs).toBeNull();
  });

  it("marks the current phase active and the phases the log completed complete", () => {
    const events = [
      event("job.created"),
      event("job.claimed", { from: "queued", to: "provisioning" }),
      ...phase("Provision sandbox", "queued", "provisioning", 4_000),
      ...phase("Establish test baseline", "provisioning", "analyzing", 9_000),
      event("phase.started", { phase: "Create plan", from: "analyzing", to: "planning" }),
    ];

    expect(states(events, "planning")).toEqual([
      "complete",
      "complete",
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);

    const progress = derivePhaseProgress(events, "planning");
    expect(progress.activePhase).toBe("planning");
    expect(progress.completedCount).toBe(2);
    expect(progress.totalDurationMs).toBe(13_000);
    expect(progress.segments[1]?.durationMs).toBe(9_000);
  });

  it("does not infer completion from position, so a skipped phase stays pending", () => {
    // What a checkpoint resume looks like: provisioning ran again, and the run
    // continued at `implementing` without ever replaying planning.
    const events = [
      event("job.claimed", { from: "queued", to: "provisioning" }),
      ...phase("Provision sandbox", "queued", "provisioning", 5_000),
      event("run.resumed", { from: "provisioning", to: "implementing" }),
      event("phase.started", { phase: "Implement change" }),
    ];

    expect(states(events, "implementing")).toEqual([
      "complete",
      "pending",
      "pending",
      "active",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("sums a phase visited twice rather than opening a second segment", () => {
    const events = [
      event("job.claimed", { from: "queued", to: "provisioning" }),
      ...phase("Provision sandbox", "queued", "provisioning", 3_000),
      ...phase("Implement change", "provisioning", "implementing", 30_000),
      ...phase("Validate change", "implementing", "testing", 12_000),
      ...phase("Review patch", "testing", "reviewing", 8_000),
      ...phase("Revise change", "reviewing", "revising", 20_000),
      ...phase("Validate change", "revising", "testing", 11_000),
      ...phase("Review patch", "testing", "reviewing", 7_000),
    ];

    const progress = derivePhaseProgress(events, "finalizing");
    const testing = progress.segments.find((segment) => segment.status === "testing");
    const reviewing = progress.segments.find((segment) => segment.status === "reviewing");

    expect(progress.segments).toHaveLength(PIPELINE_PHASES.length);
    expect(testing?.durationMs).toBe(23_000);
    expect(testing?.visits).toBe(2);
    expect(reviewing?.durationMs).toBe(15_000);
    expect(progress.revisions).toBe(1);
  });

  it("folds `revising` onto the implementing segment rather than an eighth step", () => {
    const events = [
      event("job.claimed", { from: "queued", to: "provisioning" }),
      ...phase("Implement change", "provisioning", "implementing", 30_000),
      ...phase("Review patch", "implementing", "reviewing", 8_000),
      event("phase.started", { phase: "Revise change", from: "reviewing", to: "revising" }),
    ];

    const progress = derivePhaseProgress(events, "revising");

    expect(progress.segments).toHaveLength(PIPELINE_PHASES.length);
    expect(progress.activePhase).toBe("implementing");
    expect(progress.revisions).toBe(1);
  });

  it("reports no active phase on a terminal job and keeps where it stopped", () => {
    const events = [
      event("job.claimed", { from: "queued", to: "provisioning" }),
      ...phase("Provision sandbox", "queued", "provisioning", 4_000),
      ...phase("Establish test baseline", "provisioning", "analyzing", 6_000),
      event("phase.started", { phase: "Create plan", from: "analyzing", to: "planning" }),
      event("job.failed", { from: "planning", to: "failed", failureCategory: "plan_not_produced" }),
    ];

    const progress = derivePhaseProgress(events, "failed");

    expect(progress.terminal).toBe(true);
    expect(progress.activePhase).toBeNull();
    expect(progress.lastPhase).toBe("planning");
    expect(progress.completedCount).toBe(2);
    expect(states(events, "failed")).not.toContain("active");
  });

  it("ignores phase events that carry no label and events out of order", () => {
    const ordered = [
      event("job.claimed", { from: "queued", to: "provisioning" }),
      ...phase("Provision sandbox", "queued", "provisioning", 4_000),
    ];
    const shuffled = [...ordered].reverse();

    expect(derivePhaseProgress(shuffled, "analyzing")).toEqual(
      derivePhaseProgress(ordered, "analyzing"),
    );
    expect(derivePhaseProgress([event("phase.completed", {})], "analyzing").completedCount).toBe(0);
  });

  it("ignores a negative or non-finite duration instead of subtracting it", () => {
    const events = [
      event("job.claimed", { from: "queued", to: "provisioning" }),
      event("phase.started", { phase: "Provision sandbox" }),
      event("phase.completed", { phase: "Provision sandbox", durationMs: -5 }),
    ];

    const progress = derivePhaseProgress(events, "analyzing");
    expect(progress.segments[0]?.state).toBe("complete");
    expect(progress.segments[0]?.durationMs).toBeNull();
  });
});

describe("pipelinePhaseIndex", () => {
  it("is one-based over the walk and null for everything that is not a step", () => {
    expect(pipelinePhaseIndex("provisioning")).toBe(1);
    expect(pipelinePhaseIndex("finalizing")).toBe(PIPELINE_PHASES.length);
    expect(pipelinePhaseIndex("queued")).toBeNull();
    expect(pipelinePhaseIndex("revising")).toBeNull();
    expect(pipelinePhaseIndex("completed")).toBeNull();
  });
});
