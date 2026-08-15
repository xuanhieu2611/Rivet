/**
 * The Milestone 6 acceptance trace, and the assertions that read it.
 *
 * In `src/` rather than in the integration suite because two very different
 * callers need the same definition of "this run recovered": the Stage 0
 * contract test, which asserts the trace exists and keeps later stages honest,
 * and `pnpm demo:recovery`, which is the run that has to satisfy it end to end
 * against Docker. A copy in each would drift, and the copy that drifted would
 * be the one nobody ran.
 */

/**
 * The Milestone 6 north-star trace.
 *
 * These are acceptance milestones rather than every command and agent event in
 * the run. The `type:detail` entries retain the phase, attempt, generation and
 * checkpoint kind that make a recovery trace meaningful, while leaving room
 * for the bounded activity rows between them.
 *
 * The trace is intentionally declared before the M6 schema and pipeline work.
 * Later stages may add smaller tests, but they must make this sequence true
 * rather than weakening it to fit a local implementation.
 */
export const MILESTONE_6_RECOVERY_EVENT_SEQUENCE = [
  "job.created",
  "job.enqueued:generation-0",
  "job.claimed:attempt-1",
  "phase.started:Provision sandbox",
  "phase.completed:Provision sandbox",
  "phase.started:Establish test baseline",
  "baseline.recorded",
  "phase.completed:Establish test baseline",
  "phase.started:Create plan",
  "agent.session_started",
  "plan.recorded",
  "checkpoint.created:phase_boundary",
  "phase.completed:Create plan",
  "phase.started:Implement change",
  "agent.session_started",
  "agent.turn_completed",
  "checkpoint.created:agent_turn",
  "job.reclaimed",
  "job.enqueued:generation-1",
  "job.claimed:attempt-2",
  "phase.started:Provision sandbox",
  "checkpoint.restored",
  "run.resumed",
  "phase.started:Implement change",
  "agent.session_started",
  "phase.started:Validate change",
  "validation.recorded",
  "phase.completed:Validate change",
  "phase.started:Review patch",
  "phase.completed:Review patch",
  "phase.started:Finalize",
  "run.summarized",
  "phase.completed:Finalize",
  "job.completed",
] as const;

/**
 * The ten facts the recovery fixture must prove in addition to its event
 * trace. These names are kept next to the trace so a future test cannot
 * accidentally cover only the happy-path status sequence.
 */
export interface Milestone6RecoveryFacts {
  planPersisted: boolean;
  nonEmptyImplementationCheckpoint: boolean;
  workerATerminatedUncleanly: boolean;
  leaseExpiredAndReclaimAdvancedDispatchGeneration: boolean;
  workerBClaimedBeforeBullMQStalled: boolean;
  replacementSandboxAtSameBaseCommit: boolean;
  restoredPatchChecksumMatches: boolean;
  analysisAndPlanningNotRerun: boolean;
  freshSessionReceivedRecoveryContext: boolean;
  validationCompletedAndJobCompleted: boolean;
}

/**
 * Converts a durable event into the compact key used by the north-star trace.
 *
 * M6 adds the extra data fields used below. Reading them through a loose record
 * keeps this Stage 0 support layer compatible with the current M5 contracts,
 * without adding any of those future fields early.
 */
export function recoveryEventKey(event: {
  type: string;
  data: Record<string, unknown> | null;
}): string {
  const type = String(event.type);
  const data = event.data;

  if (type === "phase.started" || type === "phase.completed") {
    const phase = typeof data?.phase === "string" ? data.phase : "unknown";
    return `${type}:${phase}`;
  }

  if (type === "job.claimed") {
    const attempt = typeof data?.attempt === "number" ? data.attempt : "unknown";
    return `${type}:attempt-${attempt}`;
  }

  if (type === "job.enqueued") {
    const generation =
      typeof data?.dispatchGeneration === "number" ? data.dispatchGeneration : "unknown";
    return `${type}:generation-${generation}`;
  }

  if (type === "checkpoint.created") {
    const kind =
      typeof data?.checkpointKind === "string"
        ? data.checkpointKind
        : typeof data?.kind === "string"
          ? data.kind
          : "unknown";
    return `${type}:${kind}`;
  }

  return type;
}

/**
 * Checks that the durable trace contains every acceptance milestone in order.
 * Extra command, agent and sandbox rows are allowed between milestones, but a
 * missing or reordered milestone fails loudly once the real fixture is wired.
 */
export function assertMilestone6RecoveryEventSequence(
  events: readonly { type: string; data: Record<string, unknown> | null }[],
): void {
  const actual = events.map(recoveryEventKey);
  let cursor = 0;

  for (const expected of MILESTONE_6_RECOVERY_EVENT_SEQUENCE) {
    const found = actual.indexOf(expected, cursor);
    if (found === -1) {
      const previous = actual[cursor - 1] ?? "(start)";
      throw new Error(
        `Recovery trace is missing ${expected} after ${previous}. Actual trace: ${actual.join(", ")}`,
      );
    }
    cursor = found + 1;
  }

  for (const nonReplayable of [
    "phase.started:Establish test baseline",
    "phase.started:Create plan",
  ]) {
    if (actual.filter((entry) => entry === nonReplayable).length !== 1) {
      throw new Error(
        `Recovery trace replayed ${nonReplayable}; analysis and planning must run once.`,
      );
    }
  }
}

/**
 * Checks the non-event facts that cannot be inferred from the compact trace.
 * The fixture should call this after it has read its durable rows and agent
 * specifications from both attempts.
 */
export function assertMilestone6RecoveryFacts(facts: Milestone6RecoveryFacts): void {
  const missing = Object.entries(facts)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Recovery acceptance facts are incomplete: ${missing.join(", ")}`);
  }
}
