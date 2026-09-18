import { isTerminal, jobStatusSchema, type JobEvent, type JobStatus } from "@rivet/contracts";

/**
 * The seven segments a run walks through, in order.
 *
 * Deliberately not derived from `JOB_STATUSES`: that list also carries `queued`,
 * `revising` and the five terminal statuses, none of which is a step. The order
 * here mirrors `PHASE_TEMPLATE` in `packages/core/src/pipeline/phases.ts`, and
 * the two are allowed to be written down twice for the same reason the status
 * enum is - this one is presentation, and a pipeline built with a different walk
 * still renders as the phases it actually ran.
 */
export const PIPELINE_PHASES = [
  "provisioning",
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "finalizing",
] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES)[number];

const PIPELINE_PHASE_SET: ReadonlySet<JobStatus> = new Set<JobStatus>(PIPELINE_PHASES);

export function isPipelinePhase(status: JobStatus): status is PipelinePhase {
  return PIPELINE_PHASE_SET.has(status);
}

/** One-based position of a status in the walk, or null for one that is not a step. */
export function pipelinePhaseIndex(status: JobStatus): number | null {
  const index = PIPELINE_PHASES.indexOf(status as PipelinePhase);
  return index === -1 ? null : index + 1;
}

export const PIPELINE_PHASE_LABELS: Record<PipelinePhase, string> = {
  provisioning: "Provision",
  analyzing: "Baseline",
  planning: "Plan",
  implementing: "Implement",
  testing: "Validate",
  reviewing: "Review",
  finalizing: "Finalize",
};

export type PhaseSegmentState = "complete" | "active" | "pending";

export interface PhaseSegment {
  status: PipelinePhase;
  label: string;
  state: PhaseSegmentState;
  /**
   * Total time spent in this phase, summed over every visit.
   *
   * Null until the phase has completed at least once - an active phase has a
   * start and no duration, and guessing one from the wall clock would make the
   * stepper disagree with the timeline it is derived from.
   */
  durationMs: number | null;
  /** How many times the run entered this phase. More than one means a loop. */
  visits: number;
}

export interface PhaseProgress {
  segments: readonly PhaseSegment[];
  /** The phase currently running, or null when the job is queued or terminal. */
  activePhase: PipelinePhase | null;
  /**
   * The last phase the run was observed in.
   *
   * On a terminal job this is where it stopped, which is the one thing a
   * collapsed stepper has to be able to say about a failure.
   */
  lastPhase: PipelinePhase | null;
  /** Revisions entered, rendered as a repeat badge on `implementing`. */
  revisions: number;
  /** Segments in the `complete` state, for "4 of 7". */
  completedCount: number;
  /** Summed phase durations, null when nothing has completed. */
  totalDurationMs: number | null;
  terminal: boolean;
}

interface OpenPhase {
  label: string;
  status: JobStatus;
}

/**
 * Turns the append-only event log into seven segments.
 *
 * Everything it needs is already in the timeline, which is the point: the
 * stepper opens no second data path and stays live through the same reducer the
 * timeline reads. Two facts carry it. A transition writes `from`/`to` onto its
 * event, so replaying the `to` values in id order reconstructs which status the
 * job held at any point; and `phase.started`/`phase.completed` come in pairs
 * carrying the phase label plus, on the completion, its measured `durationMs`.
 *
 * Pairing is by label rather than by position because a review loop replays
 * `implementing`, `testing` and `reviewing`, and a second visit to a phase must
 * add to its total rather than open a second segment.
 */
export function derivePhaseProgress(
  events: readonly JobEvent[],
  currentStatus: JobStatus,
): PhaseProgress {
  const durations = new Map<PipelinePhase, number>();
  const visits = new Map<PipelinePhase, number>();
  const completed = new Set<PipelinePhase>();
  const open = new Map<string, OpenPhase>();

  let runningStatus: JobStatus | null = null;
  let lastPhase: PipelinePhase | null = null;
  let revisions = 0;

  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    const to = parseStatus(event.data?.to);
    if (to) runningStatus = to;

    if (event.type === "phase.started") {
      const label = phaseLabel(event);
      // A phase whose status the log never named cannot be placed on the walk.
      // That is an old or partial event rather than an error, so it is skipped
      // instead of guessed at.
      if (label === null || runningStatus === null) continue;

      open.set(label, { label, status: runningStatus });

      if (runningStatus === "revising") revisions += 1;
      if (isPipelinePhase(runningStatus)) {
        visits.set(runningStatus, (visits.get(runningStatus) ?? 0) + 1);
        lastPhase = runningStatus;
      }
      continue;
    }

    if (event.type === "phase.completed") {
      const label = phaseLabel(event);
      if (label === null) continue;

      const started = open.get(label);
      open.delete(label);

      const status = started?.status ?? runningStatus;
      if (status === null || !isPipelinePhase(status)) continue;

      completed.add(status);
      const durationMs = event.data?.durationMs;
      if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
        durations.set(status, (durations.get(status) ?? 0) + durationMs);
      }
    }
  }

  const terminal = isTerminal(currentStatus);
  // A revision is a loop back into `implementing`, not an eighth step, so the
  // status it runs under resolves onto the segment it is revising.
  const resolvedCurrent: JobStatus = currentStatus === "revising" ? "implementing" : currentStatus;
  const activePhase = !terminal && isPipelinePhase(resolvedCurrent) ? resolvedCurrent : null;
  if (activePhase) lastPhase = activePhase;

  const segments = PIPELINE_PHASES.map<PhaseSegment>((status) => ({
    status,
    label: PIPELINE_PHASE_LABELS[status],
    state: segmentState(status, activePhase, completed),
    durationMs: durations.get(status) ?? null,
    visits: visits.get(status) ?? 0,
  }));

  const totalDurationMs = segments.reduce<number | null>(
    (total, segment) => (segment.durationMs === null ? total : (total ?? 0) + segment.durationMs),
    null,
  );

  return {
    segments,
    activePhase,
    lastPhase,
    revisions,
    completedCount: segments.filter((segment) => segment.state === "complete").length,
    totalDurationMs,
    terminal,
  };
}

/**
 * Completion is read from the log, never inferred from position.
 *
 * "Everything before the active phase is done" is wrong for exactly the runs
 * worth looking at: a job that failed in `testing` never reached `reviewing`,
 * and one resumed from a checkpoint skipped the phases before its cursor.
 */
function segmentState(
  status: PipelinePhase,
  activePhase: PipelinePhase | null,
  completed: ReadonlySet<PipelinePhase>,
): PhaseSegmentState {
  if (status === activePhase) return "active";
  return completed.has(status) ? "complete" : "pending";
}

function phaseLabel(event: JobEvent): string | null {
  const label = event.data?.phase;
  return typeof label === "string" && label.length > 0 ? label : null;
}

function parseStatus(value: unknown): JobStatus | null {
  const parsed = jobStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
