import type { JobStatus } from "@rivet/contracts";

import type { SandboxProvider } from "../sandbox/sandbox";
import { baselinePhase } from "./baseline-phase";
import type { PhaseContext } from "./phase-context";
import { provisioningPhase } from "./provisioning-phase";

/**
 * What a job actually does, as a list.
 *
 * A phase is a status, a label, and either a body or a sleep. Milestone 1 had
 * only sleeps, which was deliberate: the deliverable was everything around the
 * phases - claiming, leasing, heartbeating, transitioning, retrying,
 * cancelling, recovering - and that machinery gets far better coverage wrapping
 * a phase that can be made to fail on demand than one that clones a repository.
 *
 * Milestone 2 gives `provisioning` a real body and leaves the other six alone,
 * which is what the optional `run` is for. The runner in `run-pipeline.ts` did
 * not change shape to accommodate it, because it never imported its callbacks
 * in the first place.
 */
export interface Phase {
  /** The status the job holds while this phase runs. */
  status: JobStatus;
  /** One line for the timeline and the log. */
  label: string;
  /** The simulated duration, used only when `run` is absent. Scaled by `speed`. */
  durationMs: number;
  /**
   * The real work, when there is any.
   *
   * A phase with a body ignores `durationMs` entirely: it takes as long as the
   * work takes, and its budget is the job's `max_duration_seconds` plus each
   * command's own timeout, never a number in this file.
   */
  run?: (ctx: PhaseContext) => Promise<void>;
}

/**
 * Everything a real phase needs that is not a fact about the job.
 *
 * All of it arrives as an argument because `packages/core` reads no
 * environment - `apps/worker` parses these out of `process.env` and passes them
 * in. No field has a default here for the same reason `SandboxSpec` has none: a
 * default limit in the package that is supposed to hold no policy is how a
 * container ends up unbounded.
 */
export interface PipelineOptions {
  sandbox: SandboxProvider;
  /** Pinned by digest, not just tag. */
  image: string;
  /** The sandbox working directory; the clone lands in `repo` under it. */
  workdir: string;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  /** The ordinary per-command budget. */
  commandTimeoutMs: number;
  /** Cloning a large repository is slow in a way that is not a symptom. */
  cloneTimeoutMs: number;
  /** Longer again: a cold dependency install is the slowest thing here. */
  installTimeoutMs: number;
  /**
   * The repository's own test suite, which is allowed to be slow.
   *
   * Its own budget rather than `commandTimeoutMs`, because a four-minute suite
   * is a property of the repository and reporting it as `command_timed_out`
   * would be Rivet calling a perfectly normal project broken.
   */
  baselineTimeoutMs: number;
  /** Passed to every sandbox. Empty at Milestone 2, and that is the point. */
  env?: Record<string, string>;
}

/**
 * The happy path, in order.
 *
 * The statuses form a legal walk through `ALLOWED_TRANSITIONS` and end on
 * `finalizing`, which is the only status with a `-> completed` edge. A test
 * asserts both against every pipeline this file can build, so reordering this
 * list without updating the guard table fails before it reaches a database.
 *
 * The durations are what the simulated phases sleep for - roughly 21 seconds
 * end to end at `speed: 1`, about the right length to watch a job cross the
 * dashboard without getting bored or missing it.
 */
const PHASE_TEMPLATE: readonly Phase[] = [
  { status: "provisioning", label: "Provision sandbox", durationMs: 2_000 },
  { status: "analyzing", label: "Analyze repository", durationMs: 3_000 },
  { status: "planning", label: "Create plan", durationMs: 2_000 },
  { status: "implementing", label: "Implement change", durationMs: 5_000 },
  { status: "testing", label: "Run tests", durationMs: 4_000 },
  { status: "reviewing", label: "Review patch", durationMs: 3_000 },
  { status: "finalizing", label: "Finalize", durationMs: 2_000 },
];

/**
 * Seven sleeps: the Milestone 1 pipeline, still exactly as it was.
 *
 * A function rather than the old `SIMULATED_PIPELINE` constant so that choosing
 * simulation is a visible choice at the call site. A default that happens to be
 * fake is the kind of thing that survives into a deployment; `RIVET_SANDBOX=off`
 * selecting this one is a decision someone made and can be refused in
 * production.
 */
export function simulatedPipeline(): readonly Phase[] {
  return PHASE_TEMPLATE.map((phase) => ({ ...phase }));
}

/**
 * The same seven phases, with the ones Milestone 2 made real given a body.
 *
 * `provisioning` creates a container, clones the repository and installs its
 * dependencies; `testing` runs the repository's own suite and records what it
 * found. `analyzing`, `planning`, `implementing`, `reviewing` and `finalizing`
 * stay simulated until Milestones 4 and 5, and there is nothing clever about
 * their sleeps in the meantime - which is why this returns the same seven
 * statuses in the same order either way, and why one guard-table test walks
 * both pipelines.
 */
export function buildPipeline(options: PipelineOptions): readonly Phase[] {
  const bodies: Partial<Record<JobStatus, (ctx: PhaseContext) => Promise<void>>> = {
    provisioning: provisioningPhase(options),
    testing: baselinePhase(options),
  };

  return PHASE_TEMPLATE.map((phase) => {
    const run = bodies[phase.status];
    return run ? { ...phase, run } : { ...phase };
  });
}

/** The status a pipeline leaves a job in when every phase succeeded. */
export function finalPhaseStatus(phases: readonly Phase[] = PHASE_TEMPLATE): JobStatus {
  const last = phases.at(-1);
  if (!last) throw new Error("A pipeline must have at least one phase.");
  return last.status;
}
