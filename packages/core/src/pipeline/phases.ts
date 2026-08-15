import type { JobStatus } from "@rivet/contracts";

import type { CodingAgent } from "../agent/coding-agent";
import type { SandboxProvider } from "../sandbox/sandbox";
import { baselinePhase } from "./baseline-phase";
import { finalizingPhase } from "./finalizing-phase";
import { implementingPhase } from "./implementing-phase";
import type { PhaseContext } from "./phase-context";
import { planningPhase } from "./planning-phase";
import { provisioningPhase } from "./provisioning-phase";
import type { PhaseDirective } from "./run-pipeline";
import { validationPhase } from "./validation-phase";

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
/**
 * How a phase behaves when a reclaimed attempt reaches it again.
 *
 * Three words, and the third one is why this type exists at all:
 *
 * - `replay` - running it again is harmless. Everything it produces is a
 *   database row whose readers select the latest complete record, so a crash
 *   before the boundary checkpoint costs the work, not the correctness.
 * - `checkpoint` - the phase's partial progress is durable in its own right and
 *   recovery continues from it rather than repeating it. `implementing` is the
 *   only one in M6: its turn checkpoints are the workflow cursor.
 * - `reconcile_external` - the phase has an effect outside Rivet, so before
 *   repeating it the run must ask the provider what already happened. Nothing
 *   declares this yet, and that is the point: M9's branch, commit, push and
 *   pull request cannot be added to a phase without someone choosing this word,
 *   because the field is required and `replay` would be a claim that pushing a
 *   branch twice is harmless.
 *
 * See `docs/plans/milestone-6.md` §7 for the protocol the third one implies.
 */
export type PhaseRecovery = "replay" | "checkpoint" | "reconcile_external";

export interface Phase {
  /** The status the job holds while this phase runs. */
  status: JobStatus;
  /** One line for the timeline and the log. */
  label: string;
  /** What a reclaimed attempt is allowed to do with this phase. Required. */
  recovery: PhaseRecovery;
  /** The simulated duration, used only when `run` is absent. Scaled by `speed`. */
  durationMs: number;
  /**
   * The real work, when there is any.
   *
   * A phase with a body ignores `durationMs` entirely: it takes as long as the
   * work takes, and its budget is the job's `max_duration_seconds` plus each
   * command's own timeout, never a number in this file.
   *
   * What it returns is a `PhaseDirective`, and for every phase in this file that
   * is `undefined` - "carry on with the queue". See `run-pipeline.ts`.
   */
  run?: (ctx: PhaseContext) => Promise<PhaseDirective>;
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
  /** Lint and typecheck budget, distinct from the test-suite budget. */
  checkTimeoutMs: number;
  /** Complete reporter file read cap. Must exceed the artifact storage cap. */
  validationReportMaxBytes: number;
  /** Maximum number of conventionally selected targeted test files. */
  targetedMaxFiles: number;
  /**
   * Cap on how much diff text may cross the sandbox boundary at once.
   *
   * Distinct from the artifact bound, and deliberately above it. The artifact
   * bound decides what is *stored* and is applied by `recordArtifact`, which
   * also records the true size it was applied to. This one decides what the
   * container is allowed to print, and a diff clipped here would arrive already
   * shortened - so `byte_size` would record the clipped length as the real one,
   * which is the exact thing that column exists to prevent. Set it below the
   * artifact bound and every large diff quietly lies about its size.
   */
  diffMaxBytes: number;
  /** Passed to every sandbox. Empty at Milestone 2, and that is the point. */
  env?: Record<string, string>;
  /**
   * The coding agent, if this worker has one.
   *
   * One optional field carrying every required bound, rather than five loose
   * optional fields. The grouping is what makes "an agent arrives with all of
   * its ceilings or not at all" a thing the type system enforces: a worker
   * cannot supply a harness and forget the session deadline, which would be a
   * model running until the job's own budget ran out.
   */
  agent?: AgentOptions;
}

/**
 * The agent half of a pipeline's configuration.
 *
 * Every bound is required, the same rule `SandboxSpec` follows. A default here
 * would be policy in the package that holds no policy, and the failure mode of
 * a forgotten ceiling is a session that runs until someone reads the bill.
 */
export interface AgentOptions {
  coding: CodingAgent;
  /** The session's own deadline, distinct from the job's `max_duration_seconds`. */
  sessionTimeoutMs: number;
  /** Ceiling on turns, alongside the per-job ceilings the job row carries. */
  maxTurns: number;
  /** Cap on any single piece of session text that reaches the timeline. */
  previewMaxBytes: number;
  /** Cap on one file read out of the sandbox. */
  fileMaxBytes: number;
}

/**
 * The happy path, in order.
 *
 * The statuses form a legal walk through `ALLOWED_TRANSITIONS` and end on
 * `finalizing`, which is the only status with a `-> completed` edge. A test
 * asserts both against every pipeline this file can build, so reordering this
 * list without updating the guard table fails before it reaches a database.
 *
 * The durations are what the simulated phases sleep for - roughly 19 seconds
 * end to end at `speed: 1`, about the right length to watch a job cross the
 * dashboard without getting bored or missing it.
 *
 * `planning` remains zero-duration in the simulated pipeline because there is
 * no agent session behind it. A real pipeline supplies the dedicated planner
 * body through `buildPipeline()`. See `planning-phase.ts`.
 */
const PHASE_TEMPLATE: readonly Phase[] = [
  { status: "provisioning", label: "Provision sandbox", durationMs: 2_000, recovery: "replay" },
  {
    status: "analyzing",
    label: "Establish test baseline",
    durationMs: 3_000,
    recovery: "replay",
  },
  { status: "planning", label: "Create plan", durationMs: 0, recovery: "replay" },
  // The one phase whose partial work is a durable cursor rather than something
  // to run again: a turn checkpoint is what a replacement session continues from.
  { status: "implementing", label: "Implement change", durationMs: 5_000, recovery: "checkpoint" },
  { status: "testing", label: "Validate change", durationMs: 4_000, recovery: "replay" },
  { status: "reviewing", label: "Review patch", durationMs: 3_000, recovery: "replay" },
  // Replayable only while it writes nothing outside Rivet. M9 puts a branch, a
  // push and a pull request here, and each of those makes this
  // `reconcile_external` - which is exactly the decision this field forces.
  { status: "finalizing", label: "Finalize", durationMs: 2_000, recovery: "replay" },
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
 * The same seven phases, with the ones that have been made real given a body.
 *
 * `provisioning` creates a container, clones the repository and installs its
 * dependencies; `analyzing` runs the repository's own suite and records the
 * baseline; a configured agent makes `planning` run a dedicated read-only
 * planner, `implementing` run a coding session, `testing` judge what it did and
 * `finalizing` record what it said and what the run came to. `reviewing` still
 * sleeps, and there is nothing clever about that sleep in the meantime. Without
 * an agent, planning, implementation, validation and finalization remain
 * simulated so the infrastructure-free worker path stays usable.
 *
 * The baseline is wired to `analyzing` rather than `testing` because that is
 * what it was always for. PRD §11 C asks whether the repository was healthy
 * *before* Rivet touched it, and `testing` sits after `implementing`, so from
 * Milestone 2 until now the phase was answering that question too late for the
 * answer to mean anything. Nothing noticed because nothing read the result back;
 * Milestone 5 reads it back, so it had to move first. `job_commands.phase` for
 * those commands changes from `testing` to `analyzing`, which is why that column
 * is `text` and is never joined as a state machine: old rows keep the old value
 * and stay true about the run that wrote them.
 *
 * Leaving `implementing` simulated when there is no agent is what keeps
 * `pnpm test:integration` runnable with no model key: `RIVET_AGENT=off` omits
 * the field, the sleep stays, and thirty-odd lifecycle tests stay cheap.
 *
 * `testing` and `finalizing` are wired to the same condition, and that grouping
 * is deliberate rather than convenient. Validation's first act is to fail a job
 * whose diff is empty, which is exactly the right answer for a session that
 * changed nothing and exactly the wrong one for a pipeline that never had a
 * session: it would be validating the absence of a phase rather than the result
 * of one, and every job on a keyless laptop would fail with
 * `no_changes_produced` while nothing was wrong. `finalizing` follows for the
 * milder version of the same reason - a phase whose two outputs are the
 * session's summary and the validation outcome has nothing to summarize when
 * neither of the phases that produce them ran. Production is unaffected either
 * way, because `parseWorkerConfig` refuses `RIVET_AGENT=off` under
 * `NODE_ENV=production` - a worker that cannot write code is not a worker that
 * should be judging code.
 */
export function buildPipeline(options: PipelineOptions): readonly Phase[] {
  const bodies: Partial<Record<JobStatus, (ctx: PhaseContext) => Promise<PhaseDirective>>> = {
    provisioning: provisioningPhase(options),
    analyzing: baselinePhase(options),
    ...(options.agent
      ? {
          planning: planningPhase(options.agent, options),
          implementing: implementingPhase(options.agent, options),
          testing: validationPhase(options),
          finalizing: finalizingPhase(),
        }
      : {}),
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
