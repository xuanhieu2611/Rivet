import type { JobStatus } from "@rivet/contracts";

/**
 * What a job actually does, as a list.
 *
 * Milestone 1's phases are simulated: each one is a status, a label, and a sleep.
 * That is deliberate and it is not the deliverable. The deliverable is
 * everything around them - claiming, leasing, heartbeating, transitioning,
 * retrying, cancelling, recovering - which needs *something* to wrap in order
 * to be exercised, and gets far better coverage wrapping a phase that can be
 * made to fail on demand than one that clones a repository.
 *
 * Milestone 2 replaces the body of each phase with real sandbox work and
 * touches nothing else. That is the whole reason the runner in `run-pipeline.ts`
 * takes its callbacks as arguments rather than importing them.
 */
export interface Phase {
  /** The status the job holds while this phase runs. */
  status: JobStatus;
  /** One line for the timeline and the log. */
  label: string;
  /** Simulated work. Scaled by the runner's `speed`; Milestone 2 deletes it. */
  durationMs: number;
}

/**
 * The happy path, in order.
 *
 * Roughly 21 seconds end to end at `speed: 1`, which is about the right length
 * to watch a job move across the dashboard without getting bored or missing it.
 * Tests run the identical list at `speed: 0`.
 *
 * The statuses form a legal walk through `ALLOWED_TRANSITIONS` and end on
 * `finalizing`, which is the only status with a `-> completed` edge. A test
 * asserts both, so reordering this list without updating the guard table fails
 * before it reaches a database.
 */
export const SIMULATED_PIPELINE: readonly Phase[] = [
  { status: "provisioning", label: "Provision sandbox", durationMs: 2_000 },
  { status: "analyzing", label: "Analyze repository", durationMs: 3_000 },
  { status: "planning", label: "Create plan", durationMs: 2_000 },
  { status: "implementing", label: "Implement change", durationMs: 5_000 },
  { status: "testing", label: "Run tests", durationMs: 4_000 },
  { status: "reviewing", label: "Review patch", durationMs: 3_000 },
  { status: "finalizing", label: "Finalize", durationMs: 2_000 },
];

/** The status a pipeline leaves a job in when every phase succeeded. */
export function finalPhaseStatus(phases: readonly Phase[] = SIMULATED_PIPELINE): JobStatus {
  const last = phases.at(-1);
  if (!last) throw new Error("A pipeline must have at least one phase.");
  return last.status;
}
