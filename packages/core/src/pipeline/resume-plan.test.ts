import type { JobStatus } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import type { JobCheckpoint } from "../checkpoints/checkpoint-store";
import { CheckpointCorruptError } from "../jobs/failure";
import type { Phase } from "./phases";
import { simulatedPipeline } from "./phases";
import { BOUNDARY_CHECKPOINT_PHASES, isBoundaryCheckpointPhase, planResume } from "./resume-plan";

/**
 * Phase selection, with no database, no container and no checkpoint store.
 *
 * That is the whole point of keeping the planner pure: "which phases does this
 * claim run" is a decision worth being able to read off a table of literals,
 * rather than one that can only be observed by killing a worker.
 */

const PHASES = simulatedPipeline();
const REVISING: Phase = {
  status: "revising",
  label: "Revise change",
  durationMs: 0,
  recovery: "checkpoint",
};

const statuses = (phases: readonly Phase[]): JobStatus[] => phases.map((phase) => phase.status);

function checkpoint(overrides: Partial<JobCheckpoint> = {}): JobCheckpoint {
  return {
    id: 12,
    jobId: "11111111-2222-3333-4444-555555555555",
    sequence: 3,
    attemptCount: 1,
    kind: "agent_turn",
    completedPhase: null,
    resumePhase: "implementing",
    agentTurn: 2,
    baseCommitSha: "abc1234",
    sandboxId: "c0ffee",
    envFingerprint: {},
    state: { version: 1 },
    patchFormat: "git_binary_full_index",
    patchCompression: "gzip",
    patchSha256: "0".repeat(64),
    patchByteSize: 0,
    patchCompressedBytes: 0,
    patch: new Uint8Array(),
    restorePatch: new Uint8Array(),
    createdAt: new Date("2026-08-14T10:00:00Z"),
    ...overrides,
  };
}

describe("planResume", () => {
  it("runs the whole pipeline when there is nothing to resume", () => {
    const plan = planResume({ phases: PHASES, checkpoint: null });

    expect(plan.kind).toBe("fresh");
    expect(statuses(plan.phases)).toEqual(statuses(PHASES));
  });

  it("keeps provisioning in front of the suffix, because an environment has to exist", () => {
    // A recovered run cannot truthfully display `implementing` before it has a
    // container, a clone and the restored patch - which is the phase that does
    // all three.
    const plan = planResume({ phases: PHASES, checkpoint: checkpoint() });

    expect(plan.kind).toBe("checkpoint");
    expect(statuses(plan.phases)).toEqual([
      "provisioning",
      "implementing",
      "testing",
      "reviewing",
      "finalizing",
    ]);
  });

  it("skips the phases a boundary checkpoint acknowledged", () => {
    const plan = planResume({
      phases: PHASES,
      checkpoint: checkpoint({
        kind: "phase_boundary",
        completedPhase: "testing",
        resumePhase: "reviewing",
        agentTurn: null,
      }),
    });

    expect(statuses(plan.phases)).toEqual(["provisioning", "reviewing", "finalizing"]);
  });

  it("does not rerun analysis or planning after their boundary", () => {
    // The baseline means "before Rivet edited anything", so rerunning
    // `analyzing` over a restored workspace would quietly change what it means.
    const plan = planResume({
      phases: PHASES,
      checkpoint: checkpoint({
        kind: "phase_boundary",
        completedPhase: "planning",
        resumePhase: "implementing",
        agentTurn: null,
      }),
    });

    expect(statuses(plan.phases)).not.toContain("analyzing");
    expect(statuses(plan.phases)).not.toContain("planning");
  });

  it("carries the patch and the checkpoint through for the restore", () => {
    const restorePatch = new Uint8Array([1, 2, 3]);
    const plan = planResume({ phases: PHASES, checkpoint: checkpoint({ restorePatch }) });

    expect(plan.kind === "checkpoint" && plan.restorePatch).toBe(restorePatch);
    expect(plan.kind === "checkpoint" && plan.resumePhase).toBe("implementing");
  });

  it("inserts a directive-only revising phase when recovery resumes there", () => {
    const plan = planResume({
      phases: PHASES,
      directivePhases: [REVISING],
      checkpoint: checkpoint({
        kind: "phase_boundary",
        completedPhase: "reviewing",
        resumePhase: "revising",
        agentTurn: null,
      }),
    });

    expect(statuses(plan.phases)).toEqual([
      "provisioning",
      "revising",
      "testing",
      "reviewing",
      "finalizing",
    ]);
  });

  it("does not insert a skipped revision into an ordinary recovery suffix", () => {
    const plan = planResume({
      phases: PHASES,
      directivePhases: [REVISING],
      checkpoint: checkpoint({
        kind: "phase_boundary",
        completedPhase: "testing",
        resumePhase: "reviewing",
        agentTurn: null,
      }),
    });

    expect(statuses(plan.phases)).toEqual(["provisioning", "reviewing", "finalizing"]);
  });

  it("refuses a cursor this pipeline cannot honour rather than starting over", () => {
    // Silently falling back to the fresh walk would discard acknowledged work
    // while claiming to recover it, which is the one outcome M6 exists to
    // prevent.
    expect(() =>
      planResume({
        phases: PHASES.slice(0, 3),
        checkpoint: checkpoint({
          kind: "phase_boundary",
          completedPhase: "testing",
          resumePhase: "reviewing",
          agentTurn: null,
        }),
      }),
    ).toThrow(CheckpointCorruptError);
  });

  it("refuses a cursor pointing at the entry phase", () => {
    expect(() =>
      planResume({ phases: PHASES, checkpoint: checkpoint({ resumePhase: "provisioning" }) }),
    ).toThrow(CheckpointCorruptError);
  });

  it("resumes an interrupted revision turn at revising", () => {
    const plan = planResume({
      phases: PHASES,
      directivePhases: [REVISING],
      checkpoint: checkpoint({ kind: "agent_turn", resumePhase: "revising" }),
    });

    expect(statuses(plan.phases)).toEqual([
      "provisioning",
      "revising",
      "testing",
      "reviewing",
      "finalizing",
    ]);
  });

  it("refuses a pipeline that does not start by provisioning", () => {
    expect(() => planResume({ phases: PHASES.slice(1), checkpoint: null })).toThrow(
      /must begin with provisioning/,
    );
  });
});

describe("isBoundaryCheckpointPhase", () => {
  it("captures the phases whose work is worth resuming", () => {
    expect(isBoundaryCheckpointPhase("analyzing")).toBe(true);
    expect(isBoundaryCheckpointPhase("planning")).toBe(true);
    expect(isBoundaryCheckpointPhase("implementing")).toBe(true);
    expect(isBoundaryCheckpointPhase("testing")).toBe(true);
  });

  it("excludes provisioning, so hydration cannot overwrite a later cursor", () => {
    // A recovery claim provisions before it resumes. If that completion wrote a
    // boundary, it would replace "resume implementing" with "resume analyzing"
    // and rerun the baseline over an edited tree.
    expect(isBoundaryCheckpointPhase("provisioning")).toBe(false);
  });

  it("excludes finalizing, whose transition to completed is its acknowledgement", () => {
    expect(isBoundaryCheckpointPhase("finalizing")).toBe(false);
    expect(BOUNDARY_CHECKPOINT_PHASES).not.toContain("finalizing");
  });
});
