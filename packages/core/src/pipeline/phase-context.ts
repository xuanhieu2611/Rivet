import type { JobDetail, JobEventData, JobEventType } from "@rivet/contracts";
import { db, type Database } from "@rivet/database";

import { appendEvent } from "../events/event-service";
import { LeaseLostError } from "../jobs/failure";
import { type ProvisioningPatch, recordProvisioning } from "../jobs/provisioning";
import { recordCommand } from "../sandbox/command-log";
import type { ExecResult } from "../sandbox/sandbox";
import type { SandboxHolder } from "../sandbox/sandbox-holder";
import type { Phase } from "./phases";

/**
 * What a real phase is allowed to do, and how it does it.
 *
 * Every effect a phase can have on the outside world arrives as a method on
 * this object rather than as an import inside the phase body. That is not
 * ceremony: it is what makes a phase testable without a database, which is the
 * same property `pnpm test` has depended on since Milestone 0. A phase written
 * against this interface is pure orchestration - decide what command to run,
 * decide what a non-zero exit means - and the wiring to Postgres and to Docker
 * lives in exactly one place, `createPhaseContextFactory` below.
 *
 * What it deliberately does **not** carry is configuration. The image, the
 * limits and the timeouts are baked into the phase closures by `buildPipeline`,
 * because a phase asking its context "what is my memory limit" would be a phase
 * that could be run with the wrong one.
 */
export interface PhaseContext {
  /** The job as it was claimed. `repoUrl` and `baseBranch` come from here. */
  job: JobDetail;
  /** The phase currently running, which is what a command row is stamped with. */
  phase: Phase;
  /** Where the run's container lives, from creation until the processor destroys it. */
  sandboxes: SandboxHolder;
  /** Cancellation, job timeout and worker shutdown all arrive here. */
  signal: AbortSignal;
  log: PhaseLogger;

  /**
   * Runs a command in the run's sandbox and records that it ran.
   *
   * One call, three consequences: the command executes, a `job_commands` row
   * holds its transcript, and a `command.completed` event points at that row.
   * A non-zero exit comes back as a result rather than an exception - the phase
   * is the only thing that knows whether this particular command was allowed to
   * fail.
   */
  exec(input: PhaseExecInput): Promise<RecordedCommand>;

  /** Appends one line to the job's timeline. */
  event(input: PhaseEventInput): Promise<void>;

  /** Records what the run is executing in. Throws `LeaseLostError` if the lease is gone. */
  recordProvisioning(patch: ProvisioningPatch): Promise<void>;
}

/** The slice of a pino logger a phase uses. Structured first, message second. */
export interface PhaseLogger {
  debug(details: Record<string, unknown>, message: string): void;
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export interface PhaseExecInput {
  /** Never a shell string. There is no shell in the execution path. */
  argv: string[];
  cwd: string;
  /** This command's own budget, distinct from the job's `max_duration_seconds`. */
  timeoutMs: number;
  env?: Record<string, string>;
  /** Overrides the run's default cap, for a command known to print a lot. */
  maxOutputBytes?: number;
}

/** An `ExecResult` plus the id of the row holding its transcript. */
export interface RecordedCommand extends ExecResult {
  commandId: number;
}

export interface PhaseEventInput {
  type: JobEventType;
  message: string;
  data?: JobEventData;
}

export interface PhaseContextOptions {
  job: JobDetail;
  /** The fencing token. Every write this context makes carries it. */
  leaseOwner: string;
  sandboxes: SandboxHolder;
  signal: AbortSignal;
  log: PhaseLogger;
  /** Default cap on each of stdout and stderr, per command. */
  maxOutputBytes: number;
  database?: Database;
}

/**
 * Wires the context to the real database. The worker's half of the split.
 *
 * A factory of factories because the phase is not known until the runner
 * reaches it, and `phase` is what a command row is stamped with. Everything
 * else about a run - the job, the lease, the holder, the signal - is fixed for
 * the whole run and is captured once.
 */
export function createPhaseContextFactory(
  options: PhaseContextOptions,
): (phase: Phase) => PhaseContext {
  const database = options.database ?? db;
  const { job, leaseOwner, sandboxes, signal, log } = options;

  return (phase) => ({
    job,
    phase,
    sandboxes,
    signal,
    log,

    async exec(input) {
      const sandbox = sandboxes.require();
      log.debug({ argv: input.argv, cwd: input.cwd }, "running a command in the sandbox");

      const result = await sandbox.exec({
        argv: input.argv,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        signal,
        maxOutputBytes: input.maxOutputBytes ?? options.maxOutputBytes,
        // `exactOptionalPropertyTypes` is on, so an absent env has to be an
        // absent key rather than an explicit `undefined`.
        ...(input.env ? { env: input.env } : {}),
      });

      // The row and the event that points at it go in together, for the same
      // reason a status change and its event do: an event carrying a
      // `commandId` that resolves to nothing is worse than no event at all.
      const command = await database.transaction(async (tx) => {
        const recorded = await recordCommand({ jobId: job.id, phase: phase.status, result }, tx);
        await appendEvent(
          {
            jobId: job.id,
            type: "command.completed",
            message: `${result.argv.join(" ")} exited ${result.exitCode ?? "(killed)"}`,
            // Deliberately not the transcript. The timeline is read in full on
            // every render; the output is one join away in `job_commands`.
            data: {
              argv: result.argv,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              commandId: recorded.id,
              phase: phase.label,
            },
          },
          tx,
        );
        return recorded;
      });

      return { ...result, commandId: command.id };
    },

    async event(input) {
      await appendEvent(
        {
          jobId: job.id,
          type: input.type,
          message: input.message,
          ...(input.data ? { data: input.data } : {}),
        },
        database,
      );
    },

    async recordProvisioning(patch) {
      const held = await recordProvisioning(job.id, leaseOwner, patch, database);
      if (!held) {
        // Someone else owns this job now. Raising here rather than continuing
        // is the whole point of the fence: the next thing this phase would do
        // is write into a run that is not ours.
        throw new LeaseLostError(
          `Job ${job.id} is no longer leased by ${leaseOwner}; provisioning stood down.`,
        );
      }
    },
  });
}
