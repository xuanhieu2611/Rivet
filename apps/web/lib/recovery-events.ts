import type { CheckpointKind, JobEvent, JobEventType } from "@rivet/contracts";

import { formatBytes } from "@/lib/format";
import { FAILURE_CATEGORY_LABELS, statusLabel } from "@/lib/job-status";

/**
 * The recovery half of the timeline, as data rather than as JSX.
 *
 * Milestone 6 events describe a mechanism the reader cannot see: a workspace
 * captured after a turn, a container that is not the one the work started in, a
 * delivery generation that makes the dead worker's message harmless. The
 * supporting facts are always already in the event's `data` - checkpoint patch
 * payloads are deliberately not exposed anywhere in the web surface - so the
 * whole presentation is a pure function of one row, which is what lets it be
 * tested without rendering a component.
 *
 * A `null` return means "this is not a recovery event", and the timeline falls
 * back to its ordinary message-plus-details row.
 */
export interface RecoveryEventPresentation {
  /** The short heading before the message, e.g. `Checkpoint 3`. */
  label: string;
  /** How the row should read: an ending that went well, one that did not, or progress. */
  emphasis: "neutral" | "positive" | "negative";
  /** One sentence saying what the event means, independent of the writer's message. */
  explanation: string;
  /** The supporting facts, already formatted, in reading order. */
  facts: readonly string[];
}

/** The event types this module presents. */
export const RECOVERY_EVENT_TYPES = [
  "plan.recorded",
  "checkpoint.created",
  "checkpoint.restored",
  "checkpoint.rejected",
  "run.resumed",
  "job.reclaimed",
] as const satisfies readonly JobEventType[];

const RECOVERY_EVENT_TYPE_SET: ReadonlySet<string> = new Set(RECOVERY_EVENT_TYPES);

export function isRecoveryEvent(event: JobEvent): boolean {
  return RECOVERY_EVENT_TYPE_SET.has(event.type);
}

const CHECKPOINT_KIND_LABELS: Record<CheckpointKind, string> = {
  phase_boundary: "phase boundary",
  agent_turn: "agent turn",
};

export function describeRecoveryEvent(event: JobEvent): RecoveryEventPresentation | null {
  switch (event.type) {
    case "plan.recorded":
      return describePlanRecorded(event);
    case "checkpoint.created":
      return describeCheckpointCreated(event);
    case "checkpoint.restored":
      return describeCheckpointRestored(event);
    case "checkpoint.rejected":
      return describeCheckpointRejected(event);
    case "run.resumed":
      return describeRunResumed(event);
    case "job.reclaimed":
      return describeReclaimed(event);
    default:
      return null;
  }
}

function describePlanRecorded(event: JobEvent): RecoveryEventPresentation {
  const data = event.data;

  return {
    label: "Plan",
    emphasis: "neutral",
    explanation:
      "The planner submitted a structured plan. It is persisted as an artifact, so a replacement session reads it rather than reconstructing it.",
    facts: compact([
      data?.artifactId === undefined ? null : `artifact #${String(data.artifactId)}`,
      data?.agentRole ? `${data.agentRole} session` : null,
    ]),
  };
}

function describeCheckpointCreated(event: JobEvent): RecoveryEventPresentation {
  const data = event.data;
  const kind = checkpointKind(event);

  return {
    label: checkpointLabel(event),
    emphasis: "neutral",
    explanation:
      kind === "agent_turn"
        ? "A completed model turn was captured as a lossless patch against the base commit. A crash after this point resumes here."
        : "The phase completed and its workspace was captured, so recovery starts at the next phase instead of repeating this one.",
    facts: compact([
      kind ? CHECKPOINT_KIND_LABELS[kind] : null,
      resumeFact(event),
      turnFact(event),
      data?.attempt === undefined ? null : `attempt ${String(data.attempt)}`,
      patchSizeFact(event),
      patchStatsFact(event),
      data?.sandboxId ? `sandbox ${shortId(data.sandboxId)}` : null,
    ]),
  };
}

function describeCheckpointRestored(event: JobEvent): RecoveryEventPresentation {
  const data = event.data;
  const original = data?.originalSandboxId ?? data?.sourceSandboxId;
  const replacement = data?.replacementSandboxId ?? data?.sandboxId;

  return {
    label: checkpointLabel(event),
    emphasis: "positive",
    explanation:
      "The patch was applied into a newly provisioned container and the regenerated diff matched the stored checksum, so the restored workspace is the one that was acknowledged.",
    facts: compact([
      original && replacement && original !== replacement
        ? `sandbox ${shortId(original)} -> ${shortId(replacement)}`
        : replacement
          ? `sandbox ${shortId(replacement)}`
          : null,
      data?.commitSha ? `base ${shortId(data.commitSha)}` : null,
      turnFact(event),
      resumeFact(event),
      patchSizeFact(event),
      patchStatsFact(event),
      data?.patchSha256 ? "checksum verified" : null,
    ]),
  };
}

function describeCheckpointRejected(event: JobEvent): RecoveryEventPresentation {
  const data = event.data;

  return {
    label: checkpointLabel(event),
    emphasis: "negative",
    explanation:
      "Acknowledged work could not be captured or restored. The run stops here rather than quietly starting over from the base commit.",
    facts: compact([
      data?.failureCategory ? FAILURE_CATEGORY_LABELS[data.failureCategory] : null,
      data?.argv && data.argv.length > 0 ? data.argv.join(" ") : null,
    ]),
  };
}

function describeRunResumed(event: JobEvent): RecoveryEventPresentation {
  const data = event.data;

  return {
    label: "Resumed",
    emphasis: "neutral",
    explanation:
      "The environment was rebuilt and verified, so this attempt continues from the recorded cursor instead of rerunning the phases before it.",
    facts: compact([
      data?.resumePhase ? `continues at ${statusLabel(data.resumePhase)}` : null,
      checkpointSequence(event) === null ? null : `checkpoint ${String(checkpointSequence(event))}`,
      data?.attempt === undefined ? null : `attempt ${String(data.attempt)}`,
      data?.dispatchGeneration === undefined
        ? null
        : `generation ${String(data.dispatchGeneration)}`,
    ]),
  };
}

function describeReclaimed(event: JobEvent): RecoveryEventPresentation {
  const data = event.data;

  return {
    label: "Reclaimed",
    emphasis: "neutral",
    explanation:
      "The lease expired, so the job went back to the queue under a new delivery generation. The previous worker's message can no longer claim it.",
    facts: compact([
      data?.leaseOwner ? `previous owner ${data.leaseOwner}` : null,
      data?.attempt === undefined ? null : `attempt ${String(data.attempt)}`,
      data?.dispatchGeneration === undefined
        ? null
        : `generation ${String(data.dispatchGeneration)}`,
    ]),
  };
}

function checkpointLabel(event: JobEvent): string {
  const sequence = checkpointSequence(event);
  return sequence === null ? "Checkpoint" : `Checkpoint ${String(sequence)}`;
}

/**
 * The sequence, under either of the two names the contract accepts.
 *
 * `JobEventData` carries `sequence` as an alias for producers that use the
 * column name directly, so a reader that only knew one of them would drop the
 * number from half the rows.
 */
function checkpointSequence(event: JobEvent): number | null {
  return event.data?.checkpointSequence ?? event.data?.sequence ?? null;
}

function checkpointKind(event: JobEvent): CheckpointKind | null {
  const kind = event.data?.checkpointKind ?? event.data?.kind;
  return kind === "phase_boundary" || kind === "agent_turn" ? kind : null;
}

/**
 * Where the cursor points, said once.
 *
 * A phase-boundary checkpoint knows both halves, and `analyzing -> planning`
 * says more than either end alone; an agent-turn checkpoint has only the resume
 * phase, because the phase it belongs to has not finished.
 */
function resumeFact(event: JobEvent): string | null {
  const data = event.data;
  if (!data?.resumePhase) return null;
  return data.completedPhase
    ? `${statusLabel(data.completedPhase)} -> ${statusLabel(data.resumePhase)}`
    : `resumes at ${statusLabel(data.resumePhase)}`;
}

/**
 * Which turn a checkpoint was taken after.
 *
 * The checkpoint's `turn` is the job's cumulative completed-turn count, not the
 * zero-based per-session index the agent rows carry, so it is stated as written
 * and worded as a boundary rather than as a turn number the reader could line up
 * against `Turn 1 started`.
 */
function turnFact(event: JobEvent): string | null {
  const turn = event.data?.turn;
  return turn === undefined ? null : `after turn ${String(turn)}`;
}

function patchSizeFact(event: JobEvent): string | null {
  const data = event.data;
  if (data?.patchByteSize === undefined) return null;
  const stored = data.patchCompressedBytes;
  return stored === undefined
    ? `${formatBytes(data.patchByteSize)} patch`
    : `${formatBytes(data.patchByteSize)} patch (${formatBytes(stored)} stored)`;
}

function patchStatsFact(event: JobEvent): string | null {
  const data = event.data;
  const { filesChanged, insertions, deletions } = data ?? {};
  if (filesChanged === undefined) return null;
  if (filesChanged === 0) return "no workspace changes";
  const files = `${String(filesChanged)} ${filesChanged === 1 ? "file" : "files"}`;
  if (insertions === undefined || deletions === undefined) return files;
  return `${files}, +${String(insertions)}/-${String(deletions)}`;
}

function shortId(id: string): string {
  return id.slice(0, 12);
}

function compact(values: readonly (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null && value.length > 0);
}
