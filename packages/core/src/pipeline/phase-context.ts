import { randomUUID } from "node:crypto";

import type { ArtifactType, JobDetail, JobEventData, JobEventType } from "@rivet/contracts";
import { db, type Database } from "@rivet/database";

import { recordArtifact } from "../artifacts/artifact-store";
import { type BaselineOutcome, readBaseline } from "../events/baseline-log";
import { appendEvent } from "../events/event-service";
import { readSummary } from "../events/session-log";
import { readValidation, type ValidationRecord } from "../events/validation-log";
import { type AgentUsagePatch, recordAgentUsage as persistAgentUsage } from "../jobs/agent-usage";
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
   * One call, four consequences: a `command.started` event makes the attempt
   * visible, the command executes, a `job_commands` row holds its transcript,
   * and a `command.completed` event points at that row. If the sandbox call
   * throws, a `command.failed` event preserves the attempt without changing the
   * original exception. A non-zero exit comes back as a result rather than an
   * exception - the phase is the only thing that knows whether this particular
   * command was allowed to fail.
   */
  exec(input: PhaseExecInput): Promise<RecordedCommand>;

  /** Appends one line to the job's timeline. */
  event(input: PhaseEventInput): Promise<void>;

  /**
   * Persists one durable output of the run and points the timeline at it.
   *
   * The row and its `artifact.recorded` event go in one transaction, the same
   * argument `exec` already makes for `job_commands`: an event carrying an
   * `artifactId` that resolves to nothing is worse than no event at all.
   *
   * The content is bounded by `recordArtifact` rather than by the caller, so a
   * phase holding a diff of unknown size cannot forget - and `byteSize` on the
   * returned event says how big it really was.
   */
  artifact(input: PhaseArtifactInput): Promise<number>;

  /**
   * What `analyzing` concluded about the repository, or null if it never ran.
   *
   * A read rather than a field on this object on purpose. The baseline is a fact
   * about the job that outlives the process that established it, so the phases
   * that consume it - `implementing`, to tell the model, and `testing`, to
   * compare against - go back to the event log for it. See `events/baseline-log.ts`.
   */
  readBaseline(): Promise<BaselineOutcome | null>;

  /**
   * The last thing the coding session said, or null if it never said anything.
   *
   * The implementation summary, read back for the same reason the baseline is:
   * `runPipeline` hands nothing from one phase to the next, so the fact
   * `implementing` holds in memory has to be recovered from the log by the phase
   * that persists it. See `events/session-log.ts`.
   */
  readSummary(): Promise<string | null>;

  /**
   * What `testing` concluded, or null if it never ran.
   *
   * Null is not `unverified` - see `events/validation-log.ts`. One means the
   * comparison happened and had nothing to compare against; the other means no
   * comparison happened at all.
   */
  readValidation(): Promise<ValidationRecord | null>;

  /** Records what the run is executing in. Throws `LeaseLostError` if the lease is gone. */
  recordProvisioning(patch: ProvisioningPatch): Promise<void>;
  /** Records cumulative coding-agent usage. Throws `LeaseLostError` if the lease is gone. */
  recordAgentUsage(patch: AgentUsagePatch): Promise<void>;
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

/** An `ExecResult` plus the ids that make its transcript findable. */
export interface RecordedCommand extends ExecResult {
  commandId: number;
  /**
   * The correlation id stamped on this command's `command.started`,
   * `command.completed` and `command.failed` events.
   *
   * Returned rather than kept private because a caller may need to point at
   * this command from an event of its own - the coding agent's shell tool does
   * exactly that, so that one `agent.tool_started` row and the command
   * lifecycle it caused are the same thing on the timeline rather than two
   * unrelated entries that happen to be adjacent.
   */
  commandExecutionId: string;
}

export interface PhaseEventInput {
  type: JobEventType;
  message: string;
  data?: JobEventData;
}

export interface PhaseArtifactInput {
  type: ArtifactType;
  /** Bounded on the way in; the phase hands over whatever it has. */
  content: string;
  /** Type-specific structure, e.g. the parsed `--numstat` totals on a `diff_stat`. */
  metadata?: Record<string, unknown>;
  /** One line for the timeline. Defaults to a statement of the type and size. */
  message?: string;
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
  /**
   * Cap on one artifact's stored content.
   *
   * Its own bound rather than `maxOutputBytes`, because the two answer different
   * questions: a command transcript is a log and a diff is the work product, and
   * a diff being cut at the size that suits a build log would throw away the
   * thing the run exists to produce.
   */
  artifactMaxBytes: number;
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
  const appendOwnedEvent = (input: PhaseEventInput) =>
    database.transaction((tx) => appendEvent({ ...input, jobId: job.id, leaseOwner }, tx));

  return (phase) => ({
    job,
    phase,
    sandboxes,
    signal,
    log,

    async exec(input) {
      const sandbox = sandboxes.require();
      const commandExecutionId = randomUUID();
      log.debug({ argv: input.argv, cwd: input.cwd }, "running a command in the sandbox");

      // Make the attempt visible before Docker gets a chance to do anything.
      // If this write fails, the command is deliberately not run: an action we
      // cannot audit from its first moment is worse than a failed attempt.
      await appendOwnedEvent({
        type: "command.started",
        message: `${input.argv.join(" ")} started`,
        data: {
          commandExecutionId,
          argv: input.argv,
          cwd: input.cwd,
          phase: phase.label,
        },
      });

      let result: ExecResult;
      try {
        result = await sandbox.exec({
          argv: input.argv,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          signal,
          maxOutputBytes: input.maxOutputBytes ?? options.maxOutputBytes,
          // `exactOptionalPropertyTypes` is on, so an absent env has to be an
          // absent key rather than an explicit `undefined`.
          ...(input.env ? { env: input.env } : {}),
        });
      } catch (cause) {
        try {
          await appendOwnedEvent({
            type: "command.failed",
            message: `${input.argv.join(" ")} failed: ${describeError(cause)}`,
            data: {
              commandExecutionId,
              argv: input.argv,
              cwd: input.cwd,
              phase: phase.label,
              error: describeError(cause),
            },
          });
        } catch (eventError) {
          if (eventError instanceof LeaseLostError) throw eventError;
          // The sandbox error is the authoritative failure. A database outage
          // while recording this secondary event must never replace it.
          log.warn(
            { err: eventError, commandExecutionId },
            "could not record command failure event",
          );
        }
        throw cause;
      }

      // The row and the event that points at it go in together, for the same
      // reason a status change and its event do: an event carrying a
      // `commandId` that resolves to nothing is worse than no event at all.
      const command = await database.transaction(async (tx) => {
        const recorded = await recordCommand(
          { jobId: job.id, phase: phase.status, result, leaseOwner },
          tx,
        );
        await appendEvent(
          {
            jobId: job.id,
            type: "command.completed",
            message: `${result.argv.join(" ")} exited ${result.exitCode ?? "(killed)"}`,
            // Deliberately not the transcript. The timeline is read in full on
            // every render; the output is one join away in `job_commands`.
            data: {
              commandExecutionId,
              argv: result.argv,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              commandId: recorded.id,
              phase: phase.label,
            },
            leaseOwner,
          },
          tx,
        );
        return recorded;
      });

      return { ...result, commandId: command.id, commandExecutionId };
    },

    async event(input) {
      await appendOwnedEvent(input);
    },

    async artifact(input) {
      const artifact = await database.transaction(async (tx) => {
        const recorded = await recordArtifact(
          {
            jobId: job.id,
            type: input.type,
            phase: phase.status,
            content: input.content,
            maxBytes: options.artifactMaxBytes,
            ...(input.metadata ? { metadata: input.metadata } : {}),
            leaseOwner,
          },
          tx,
        );
        await appendEvent(
          {
            jobId: job.id,
            type: "artifact.recorded",
            message: input.message ?? describeArtifact(input.type, recorded.byteSize),
            // Deliberately not the content. The timeline is read in full on
            // every render; the artifact is one fetch away in `job_artifacts`.
            data: {
              artifactId: recorded.id,
              artifactType: recorded.type,
              byteSize: recorded.byteSize,
              truncated: recorded.truncated,
              phase: phase.label,
            },
            leaseOwner,
          },
          tx,
        );

        return recorded;
      });

      log.info(
        { artifactId: artifact.id, artifactType: artifact.type, byteSize: artifact.byteSize },
        "recorded an artifact",
      );
      return artifact.id;
    },

    readBaseline() {
      return readBaseline(job.id, database);
    },

    readSummary() {
      return readSummary(job.id, database);
    },

    readValidation() {
      return readValidation(job.id, database);
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

    async recordAgentUsage(patch) {
      const held = await persistAgentUsage(job.id, leaseOwner, patch, database);
      if (!held) {
        throw new LeaseLostError(
          `Job ${job.id} is no longer leased by ${leaseOwner}; agent usage stood down.`,
        );
      }
    },
  });
}

/** The default timeline line for an artifact: what it is and how big it really was. */
function describeArtifact(type: ArtifactType, byteSize: number): string {
  return `Recorded ${type.replace(/_/g, " ")} (${byteSize} bytes)`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
