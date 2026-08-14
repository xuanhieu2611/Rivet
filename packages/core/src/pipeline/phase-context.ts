import { randomUUID } from "node:crypto";

import type {
  ArtifactType,
  CheckpointKind,
  ImplementationPlan,
  JobDetail,
  JobEventData,
  JobEventType,
  JobStatus,
} from "@rivet/contracts";
import { db, type Database } from "@rivet/database";

import { readLatestImplementationPlan, recordArtifact } from "../artifacts/artifact-store";
import {
  getLatestCheckpoint,
  recordCheckpoint,
  type JobCheckpoint,
  type RecordCheckpointInput,
} from "../checkpoints/checkpoint-store";
import {
  captureWorkspacePatch,
  parseCheckpointPatchStats,
  type CheckpointPatchStats,
  type WorkspaceSnapshot,
  WorkspaceSnapshotError,
} from "../checkpoints/workspace-snapshot";
import { type BaselineOutcome, readBaseline } from "../events/baseline-log";
import { appendEvent } from "../events/event-service";
import { readSummary } from "../events/session-log";
import { readValidation, type ValidationRecord } from "../events/validation-log";
import { type AgentUsagePatch, recordAgentUsage as persistAgentUsage } from "../jobs/agent-usage";
import {
  CheckpointCorruptError,
  describeError as describeJobError,
  failureCategoryFor,
  LeaseLostError,
} from "../jobs/failure";
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
   * The latest valid structured implementation plan, or null when none exists.
   *
   * The plan is read back from its ordinary artifact row rather than kept in
   * process memory, so a fresh implementation session receives the same durable
   * value after a worker restart.
   */
  readImplementationPlan?: () => Promise<ImplementationPlan | null>;

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
  /** Reads the current in-run usage totals, including another phase's session. */
  readAgentUsage?: () => AgentUsageTotals;

  /**
   * The newest durable checkpoint for this job, or null when there is none.
   *
   * A read rather than something the processor hands down, for the same reason
   * the baseline is: `runPipeline` passes nothing between phases and nothing
   * survives the worker that wrote it. `provisioning` asks this on every claim,
   * so a checkpoint can only ever belong to an earlier attempt - provisioning is
   * the first phase of every claim and nothing has captured one yet.
   *
   * It throws `CheckpointCorruptError` rather than returning null for a row that
   * fails validation. Acknowledged progress that cannot be read is a failure to
   * report, not a reason to start again from the base commit.
   */
  readLatestCheckpoint(): Promise<JobCheckpoint | null>;

  /**
   * Captures the workspace as a lossless patch without persisting anything.
   *
   * The same capture `checkpoint()` performs, exposed on its own because
   * recovery has to re-derive a patch purely to compare its checksum with the
   * one it just applied. Bounds and the repository directory come from the
   * context, so a phase cannot verify a restore against a different limit than
   * the one that stored it.
   */
  captureWorkspace(input?: { repositoryDir?: string }): Promise<WorkspaceSnapshot>;

  /**
   * Persists a complete workspace snapshot at a safe recovery boundary.
   *
   * The phase supplies small workflow references and may supply a pre-captured
   * patch; otherwise the context snapshots the sandbox workspace. The context
   * supplies job identity, attempt, sandbox identity, environment fingerprint,
   * the storage bound and the lease fence. Compression, checksum, validation and
   * the `checkpoint.created` event stay in the checkpoint store.
   */
  checkpoint(input: PhaseCheckpointInput): Promise<JobCheckpoint>;
}

/** Cumulative model totals shared by planner and implementation sessions in one run. */
export interface AgentUsageTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: string;
  totalTurns: number;
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
  /** Reject rather than truncate content that must remain a complete value. */
  requireComplete?: boolean;
  /** One line for the timeline. Defaults to a statement of the type and size. */
  message?: string;
}

/** The caller-facing slice of a checkpoint request. */
export type PhaseCheckpointInput = Omit<
  RecordCheckpointInput,
  | "jobId"
  | "attemptCount"
  | "baseCommitSha"
  | "sandboxId"
  | "envFingerprint"
  | "maxBytes"
  | "leaseOwner"
  | "patch"
> & {
  /** The phase doing the capture, when this is a phase-boundary checkpoint. */
  completedPhase?: JobStatus | null;
  /** The checkpoint kind is repeated here for discoverability at phase sites. */
  kind: CheckpointKind;
  /** Optional override for callers restoring a resolved commit explicitly. */
  baseCommitSha?: string;
  /** Optional override used by recovery-aware callers. */
  sandboxId?: string;
  /** Optional current environment fingerprint override. */
  envFingerprint?: Record<string, unknown>;
  /** The cloned repository to snapshot. Defaults to the factory's repositoryDir. */
  repositoryDir?: string;
  /** A pre-captured patch is retained for lower-level callers and focused tests. */
  patch?: Uint8Array;
  /** Optional stats for a pre-captured patch. Captured patches compute them automatically. */
  patchStats?: CheckpointPatchStats;
};

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
  /** Maximum complete checkpoint payload accepted by the store. */
  checkpointMaxBytes: number;
  /** Reserved for the bounded workspace-capture operation owned by the context. */
  checkpointTimeoutMs: number;
  /** The cloned repository, used when a checkpoint caller does not pass one. */
  repositoryDir?: string;
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
  let currentBaseCommitSha = job.baseCommitSha;
  let currentEnvFingerprint = job.envFingerprint;
  let currentAgentUsage: AgentUsageTotals = {
    totalInputTokens: job.totalInputTokens ?? 0,
    totalOutputTokens: job.totalOutputTokens ?? 0,
    totalCostUsd: job.totalCostUsd ?? "0",
    totalTurns: job.totalTurns ?? 0,
  };
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
            ...(input.requireComplete ? { requireComplete: true } : {}),
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

    async readImplementationPlan() {
      const stored = await readLatestImplementationPlan(job.id, database);
      return stored?.plan ?? null;
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

      // The claimed job is an immutable snapshot. Keep the values that became
      // durable during provisioning available to later checkpoint requests,
      // without making the phase runner pass mutable state across a boundary.
      if (patch.baseCommitSha !== undefined && patch.baseCommitSha !== null) {
        currentBaseCommitSha = patch.baseCommitSha;
      }
      if (patch.envFingerprint !== undefined && patch.envFingerprint !== null) {
        currentEnvFingerprint = patch.envFingerprint;
      }
    },

    async recordAgentUsage(patch) {
      const held = await persistAgentUsage(job.id, leaseOwner, patch, database);
      if (!held) {
        throw new LeaseLostError(
          `Job ${job.id} is no longer leased by ${leaseOwner}; agent usage stood down.`,
        );
      }
      currentAgentUsage = {
        totalInputTokens: patch.totalInputTokens ?? currentAgentUsage.totalInputTokens,
        totalOutputTokens: patch.totalOutputTokens ?? currentAgentUsage.totalOutputTokens,
        totalCostUsd: patch.totalCostUsd ?? currentAgentUsage.totalCostUsd,
        totalTurns: patch.totalTurns ?? currentAgentUsage.totalTurns,
      };
    },

    readAgentUsage() {
      return { ...currentAgentUsage };
    },

    readLatestCheckpoint() {
      return getLatestCheckpoint(job.id, { maxBytes: options.checkpointMaxBytes }, database);
    },

    captureWorkspace(input) {
      return captureWorkspacePatch({
        sandbox: sandboxes.require(),
        repositoryDir: input?.repositoryDir ?? options.repositoryDir ?? "",
        signal,
        timeoutMs: options.checkpointTimeoutMs,
        maxBytes: options.checkpointMaxBytes,
      });
    },

    async checkpoint(input) {
      try {
        const sandbox = sandboxes.require();
        const baseCommitSha = input.baseCommitSha ?? currentBaseCommitSha;
        if (!baseCommitSha) {
          throw new CheckpointCorruptError(
            `Job ${job.id} has no resolved base commit for a checkpoint.`,
          );
        }

        const captured =
          input.patch === undefined
            ? await captureWorkspacePatch({
                sandbox,
                repositoryDir: input.repositoryDir ?? options.repositoryDir ?? "",
                signal,
                timeoutMs: options.checkpointTimeoutMs,
                maxBytes: options.checkpointMaxBytes,
              })
            : {
                patch: Buffer.from(input.patch),
                stats: input.patchStats ?? parseCheckpointPatchStats(input.patch),
              };
        const patchStats = input.patchStats ?? captured.stats;

        return await recordCheckpoint(
          {
            ...input,
            ...(patchStats ? { patchStats } : {}),
            jobId: job.id,
            attemptCount: job.attemptCount,
            baseCommitSha,
            sandboxId: input.sandboxId ?? sandbox.id,
            envFingerprint: input.envFingerprint ?? currentEnvFingerprint ?? {},
            maxBytes: options.checkpointMaxBytes,
            leaseOwner,
            patch: captured.patch,
          },
          database,
        );
      } catch (error) {
        if (signal.aborted) throw error;

        try {
          const details = error instanceof WorkspaceSnapshotError ? error : undefined;
          await appendOwnedEvent({
            type: "checkpoint.rejected",
            message: `Checkpoint (${input.kind}) rejected: ${describeJobError(error)}`,
            data: {
              checkpointKind: input.kind,
              failureCategory: failureCategoryFor(error),
              error: describeJobError(error),
              ...(input.agentTurn === undefined || input.agentTurn === null
                ? {}
                : { turn: input.agentTurn }),
              ...(details && details.argv.length > 0 ? { argv: [...details.argv] } : {}),
              ...(details && details.stderr.length > 0 ? { stderr: details.stderr } : {}),
            },
          });
        } catch (eventError) {
          if (eventError instanceof LeaseLostError) throw eventError;
          log.warn({ err: eventError }, "could not record rejected checkpoint");
        }
        throw error;
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
