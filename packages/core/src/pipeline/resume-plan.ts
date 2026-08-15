import type { JobStatus } from "@rivet/contracts";

import type { JobCheckpoint } from "../checkpoints/checkpoint-store";
import { CheckpointCorruptError } from "../jobs/failure";
import type { Phase } from "./phases";

/**
 * Which phases a claim actually runs, given what the last attempt acknowledged.
 *
 * Deterministic application code, and deliberately not an agent decision: the
 * durable checkpoint names the phase to resume at, and this file turns that name
 * into a legal walk through `ALLOWED_TRANSITIONS`. Nothing here reads a database
 * or a clock, so the whole of resume selection is unit-testable with a literal
 * checkpoint and a literal phase list.
 *
 * Every claim still begins at `provisioning`. A recovered run has to create and
 * verify an execution environment before it can truthfully display
 * `implementing` or `testing`, and the restore itself happens inside that phase -
 * see `provisioning-phase.ts`. What recovery changes is everything *after*
 * provisioning: the suffix beginning at the checkpoint's `resume_phase` rather
 * than the whole pipeline.
 *
 * ```text
 * checkpoint says resume implementing
 *   -> provisioning, implementing, testing, reviewing, finalizing
 *
 * checkpoint says resume testing
 *   -> provisioning, testing, reviewing, finalizing
 *
 * checkpoint says resume revising
 *   -> provisioning, revising, testing, reviewing, finalizing
 * ```
 */
export type ResumePlan =
  | { kind: "fresh"; phases: readonly Phase[] }
  | {
      kind: "checkpoint";
      checkpoint: JobCheckpoint;
      restorePatch: Uint8Array;
      resumePhase: JobStatus;
      phases: readonly Phase[];
    };

export interface ResumePlanInput {
  /** The pipeline this worker would run from scratch. */
  phases: readonly Phase[];
  /** Phases reachable only through a runtime directive. */
  directivePhases?: readonly Phase[];
  /** The newest durable checkpoint, or null on a first attempt. */
  checkpoint: JobCheckpoint | null;
}

/** The status every claim enters, recovered or not. */
const ENTRY_PHASE: JobStatus = "provisioning";

/**
 * Maps a checkpoint onto a legal pipeline suffix.
 *
 * A missing checkpoint is the ordinary case rather than an error: a first
 * attempt has nothing to resume, and so runs the pipeline it was handed.
 *
 * A checkpoint whose `resume_phase` this pipeline does not contain is a
 * `CheckpointCorruptError` rather than a silent fall back to the fresh walk.
 * Restarting from the base commit while a row says work was acknowledged is the
 * exact failure M6 exists to prevent, and a pipeline that cannot honour a cursor
 * should say so before it creates a container.
 */
export function planResume(input: ResumePlanInput): ResumePlan {
  const { phases, checkpoint } = input;

  const entry = phases.find((phase) => phase.status === ENTRY_PHASE);
  if (!entry) {
    throw new Error(`A pipeline must begin with ${ENTRY_PHASE} to be resumable.`);
  }
  if (!checkpoint) return { kind: "fresh", phases };

  const resumePhase = checkpoint.resumePhase;
  if (resumePhase === ENTRY_PHASE) {
    // No checkpoint kind produces this, and one that did would be asking the
    // run to provision twice rather than to resume anything.
    throw new CheckpointCorruptError(
      `Checkpoint ${checkpoint.sequence} resumes at ${resumePhase}, which is the entry phase.`,
    );
  }

  const attachedDirectivePhases = (
    phases as readonly Phase[] & { readonly directivePhases?: readonly Phase[] }
  ).directivePhases;
  const ordered = phaseOrder(
    phases,
    input.directivePhases ?? attachedDirectivePhases ?? [],
    resumePhase,
  );
  const index = ordered.findIndex((phase) => phase.status === resumePhase);
  if (index === -1) {
    throw new CheckpointCorruptError(
      `Checkpoint ${checkpoint.sequence} resumes at ${resumePhase}, which this pipeline does not run.`,
    );
  }

  return {
    kind: "checkpoint",
    checkpoint,
    restorePatch: checkpoint.restorePatch,
    resumePhase,
    // The entry phase from the original list rather than a copy, so a pipeline
    // built with fault injection resumes into the same instrumented bodies.
    phases: [entry, ...ordered.slice(index)],
  };
}

/**
 * Places directive-only phases at the point their cycle enters the base walk.
 *
 * M8 currently has one such phase: `revising` runs before `testing`. Keeping
 * this ordering here means a checkpoint can name that phase without putting a
 * skipped copy into the ordinary template or teaching the processor about an
 * agent's workflow.
 */
function phaseOrder(
  phases: readonly Phase[],
  directivePhases: readonly Phase[],
  resumePhase: JobStatus,
): readonly Phase[] {
  const ordered = [...phases];

  for (const directive of directivePhases) {
    // Directive-only phases are not part of an ordinary recovered suffix. They
    // are included only when the durable cursor explicitly says to resume at
    // that phase; otherwise the next directive will insert them at runtime.
    if (
      directive.status !== resumePhase ||
      ordered.some((phase) => phase === directive || phase.status === directive.status)
    ) {
      continue;
    }

    const insertBefore = ordered.findIndex((phase) => phase.status === "testing");
    ordered.splice(insertBefore === -1 ? ordered.length : insertBefore, 0, directive);
  }

  return ordered;
}

/**
 * The phases whose completion is worth a durable workflow cursor.
 *
 * Two of the seven are deliberately absent and both absences are load-bearing.
 *
 * `provisioning` produces no work to keep: its resume phase would be
 * `analyzing`, which is exactly where a fresh claim goes anyway, so the row
 * would buy a restore for a workspace identical to the clone. Worse, recovery
 * provisioning writing one would *replace* a later cursor with "resume
 * analyzing" and rerun the baseline over an edited tree - hydration is not a
 * replay of the original phase boundary, and the cheapest way to guarantee that
 * is for provisioning never to write a boundary at all.
 *
 * `finalizing` is absent because the lease-fenced transition from `finalizing`
 * to `completed` is already its durable acknowledgement. A checkpoint there
 * would only ever instruct a replacement worker to finish an already finished
 * pipeline.
 */
export const BOUNDARY_CHECKPOINT_PHASES: readonly JobStatus[] = [
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "revising",
];

/** Whether a completed phase should capture a `phase_boundary` checkpoint. */
export function isBoundaryCheckpointPhase(status: JobStatus): boolean {
  return BOUNDARY_CHECKPOINT_PHASES.includes(status);
}
