import { randomUUID } from "node:crypto";

import type {
  ArtifactType,
  BaselineReport,
  CheckpointKind,
  ExternalEffect,
  ExternalEffectKind,
  ImplementationPlan,
  JobDetail,
  JobEventData,
  JobEventType,
  JobStatus,
  ReviewReport,
  ValidationReport,
} from "@rivet/contracts";
import { db, type Database } from "@rivet/database";

import {
  readLatestArtifactContent,
  readLatestImplementationPlan,
  recordArtifact,
} from "../artifacts/artifact-store";
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
import { readBaselineReport } from "../events/baseline-report";
import { appendEvent } from "../events/event-service";
import { readSummary } from "../events/session-log";
import { readLatestReviewReport } from "../events/review-log";
import {
  readValidation,
  readValidationReport,
  type ValidationRecord,
} from "../events/validation-log";
import { type AgentUsagePatch, recordAgentUsage as persistAgentUsage } from "../jobs/agent-usage";
import {
  getExternalEffect,
  recordExternalEffectWithResult,
  type RecordExternalEffectInput,
} from "../github/effect-store";
import {
  CheckpointCorruptError,
  describeError as describeJobError,
  failureCategoryFor,
  LeaseLostError,
} from "../jobs/failure";
import { type ProvisioningPatch, recordProvisioning } from "../jobs/provisioning";
import {
  recordPublication as persistPublication,
  type PublicationPatch,
} from "../jobs/publication";
import { type ReviewPatch, recordReview as persistReview } from "../jobs/review";
import { recordCommand } from "../sandbox/command-log";
import {
  ATTR_COMMAND,
  ATTR_COMMAND_ARGC,
  ATTR_COMMAND_CWD,
  ATTR_COMMAND_EXIT_CODE,
  ATTR_COMMAND_TIMED_OUT,
  ATTR_JOB_ID,
  ATTR_PHASE,
  SPAN_SANDBOX_COMMAND,
} from "../telemetry/attributes";
import { NOOP_TELEMETRY } from "../telemetry/noop-telemetry";
import type { Telemetry } from "../telemetry/telemetry";
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
   * Where a phase's own spans go.
   *
   * Optional in the same shape as `recordExternalEffect` and
   * `readImplementationPlan` - the production factory always supplies it, and a
   * focused test harness that builds a context literal is not made to care.
   * Every use site reads it as `?? NOOP_TELEMETRY`, so the absence is a no-op
   * rather than a branch.
   *
   * A phase does not have to reach for this to be traced. `runPipeline` already
   * runs the body inside the phase span, and `exec` opens its own command span
   * underneath; this is for the phases that own an operation of their own worth
   * timing - a host clone, a publication - and for handing a parent to
   * something that outlives a block.
   */
  telemetry?: Telemetry;

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
   * Persists an external-effect receipt and its audit event in one transaction.
   *
   * Optional for compatibility with focused contexts that never publish. A
   * publication phase requires it before it can ask GitHub to create a PR.
   */
  recordExternalEffect?: (input: PhaseExternalEffectInput) => Promise<ExternalEffect>;

  /** Reads the receipt used by the publication reconciliation protocol. */
  readExternalEffect?: (kind: ExternalEffectKind) => Promise<ExternalEffect | null>;

  /** Writes branch and pull-request identities under the active lease. */
  recordPublication?: (patch: PublicationPatch) => Promise<void>;

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

  /** The latest complete multi-check baseline, or null for legacy/unreadable jobs. */
  readBaselineReport(): Promise<BaselineReport | null>;

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

  /** The latest complete multi-check validation report, or null for legacy/unreadable jobs. */
  readValidationReport(): Promise<ValidationReport | null>;

  /**
   * Reads the newest artifact body for review context.
   *
   * Optional for compatibility with focused phase harnesses that do not need
   * artifact reads. The production factory always supplies it.
   */
  readLatestArtifactContent?: (type: ArtifactType) => Promise<string | null>;

  /** The latest complete structured review report, or null when none is trusted. */
  readLatestReviewReport?: () => Promise<ReviewReport | null>;

  /** Records what the run is executing in. Throws `LeaseLostError` if the lease is gone. */
  recordProvisioning(patch: ProvisioningPatch): Promise<void>;
  /** Records cumulative coding-agent usage. Throws `LeaseLostError` if the lease is gone. */
  recordAgentUsage(patch: AgentUsagePatch): Promise<void>;
  /** Records the last review verdict and durable loop counter under the lease. */
  recordReview?(patch: ReviewPatch): Promise<void>;
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

/**
 * Cumulative model totals shared by planner and implementation sessions.
 *
 * Cumulative across attempts as well as across sessions: every field is seeded
 * from the claimed job row, which already carries whatever an interrupted
 * predecessor persisted. A session that starts here starts where the last one
 * stopped.
 */
export interface AgentUsageTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: string;
  totalTurns: number;
  totalModelCalls: number;
  totalToolCalls: number;
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

/** The phase-facing slice of an external-effect receipt request. */
export type PhaseExternalEffectInput = Omit<RecordExternalEffectInput, "jobId" | "leaseOwner"> & {
  /** Whether the provider effect was found rather than performed. */
  adopted: boolean;
};

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
  /** Where command spans go. Absent, `NOOP_TELEMETRY` records nothing. */
  telemetry?: Telemetry;
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
  const telemetry = options.telemetry ?? NOOP_TELEMETRY;
  let currentBaseCommitSha = job.baseCommitSha;
  let currentEnvFingerprint = job.envFingerprint;
  let currentAgentUsage: AgentUsageTotals = {
    totalInputTokens: job.totalInputTokens ?? 0,
    totalOutputTokens: job.totalOutputTokens ?? 0,
    totalCostUsd: job.totalCostUsd ?? "0",
    totalTurns: job.totalTurns ?? 0,
    totalModelCalls: job.totalModelCalls ?? 0,
    totalToolCalls: job.totalToolCalls ?? 0,
  };
  const appendOwnedEvent = (input: PhaseEventInput) =>
    database.transaction((tx) => appendEvent({ ...input, jobId: job.id, leaseOwner }, tx));

  return (phase) => ({
    job,
    phase,
    sandboxes,
    signal,
    log,
    telemetry,

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
        // The span covers the container call and nothing else, so its duration
        // is the command's rather than the command's plus two database writes.
        // It needs no parent: `runPipeline` has the phase span active, which is
        // what puts this command under the phase that ran it.
        //
        // Only `argv[0]` and the argument count are recorded. The rest of an
        // argv can carry a branch name, a file path or a test name out of the
        // repository under test, and a span is an export to a third-party
        // backend - the same argument `SecretRegistry` makes about log lines,
        // one system further out.
        result = await telemetry.withSpan(
          SPAN_SANDBOX_COMMAND,
          {
            kind: "client",
            attributes: {
              [ATTR_JOB_ID]: job.id,
              [ATTR_PHASE]: phase.status,
              [ATTR_COMMAND]: input.argv[0],
              [ATTR_COMMAND_ARGC]: input.argv.length - 1,
              [ATTR_COMMAND_CWD]: input.cwd,
            },
          },
          async (span) => {
            const executed = await sandbox.exec({
              argv: input.argv,
              cwd: input.cwd,
              timeoutMs: input.timeoutMs,
              signal,
              maxOutputBytes: input.maxOutputBytes ?? options.maxOutputBytes,
              // `exactOptionalPropertyTypes` is on, so an absent env has to be
              // an absent key rather than an explicit `undefined`.
              ...(input.env ? { env: input.env } : {}),
            });
            span.setAttributes({
              // Null when the command was killed rather than exiting, which the
              // port allows as a value meaning "never set" - so a timed-out
              // command carries `timed_out` and no exit code, rather than a
              // zero that would read as success.
              [ATTR_COMMAND_EXIT_CODE]: executed.exitCode ?? undefined,
              [ATTR_COMMAND_TIMED_OUT]: executed.timedOut,
            });
            // Deliberately not `setStatus("error")` on a non-zero exit. A
            // failing command is frequently the answer a phase wanted - a red
            // baseline, a check that is meant to fail - and a span marked
            // error would make every honest run look broken in a backend.
            return executed;
          },
        );
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

    async recordExternalEffect(input) {
      const recorded = await database.transaction(async (tx) => {
        const receipt = await recordExternalEffectWithResult(
          {
            ...input,
            jobId: job.id,
            leaseOwner,
          },
          tx,
        );

        if (receipt.inserted) {
          await appendEvent(
            {
              jobId: job.id,
              type: "external_effect.recorded",
              message: `Recorded ${receipt.effect.kind} external effect.`,
              data: {
                kind: receipt.effect.kind,
                provider: receipt.effect.provider,
                externalId: receipt.effect.externalId,
                externalUrl: receipt.effect.externalUrl,
                adopted: input.adopted,
              },
              leaseOwner,
            },
            tx,
          );
        }

        return receipt.effect;
      });

      return recorded;
    },

    readExternalEffect(kind) {
      return getExternalEffect(job.id, kind, database);
    },

    async recordPublication(patch) {
      const held = await persistPublication(job.id, leaseOwner, patch, database);
      if (!held) {
        throw new LeaseLostError(
          `Job ${job.id} is no longer leased by ${leaseOwner}; publication stood down.`,
        );
      }

      if (patch.finalBranch !== undefined) job.finalBranch = patch.finalBranch;
      if (patch.pullRequestNumber !== undefined) {
        job.pullRequestNumber = patch.pullRequestNumber;
      }
      if (patch.pullRequestUrl !== undefined) job.pullRequestUrl = patch.pullRequestUrl;
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

    readBaselineReport() {
      return readBaselineReport(job.id, database);
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

    readValidationReport() {
      return readValidationReport(job.id, database);
    },

    readLatestArtifactContent(type) {
      return readLatestArtifactContent(job.id, type, database);
    },

    readLatestReviewReport() {
      return readLatestReviewReport(job.id, database);
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
        job.baseCommitSha = patch.baseCommitSha;
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
        totalModelCalls: patch.totalModelCalls ?? currentAgentUsage.totalModelCalls,
        totalToolCalls: patch.totalToolCalls ?? currentAgentUsage.totalToolCalls,
      };
    },

    async recordReview(patch) {
      const held = await persistReview(job.id, leaseOwner, patch, database);
      if (!held) {
        throw new LeaseLostError(
          `Job ${job.id} is no longer leased by ${leaseOwner}; review accounting stood down.`,
        );
      }

      // The phase runner reuses this context factory for every cycle in one
      // attempt. Keep the in-memory view aligned with the fenced row so the
      // next reviewing phase reads the loop count just recorded rather than
      // the value from the initial claim.
      if (patch.reviewDecision !== undefined) job.reviewDecision = patch.reviewDecision;
      if (patch.reviewLoops !== undefined) job.reviewLoops = patch.reviewLoops;
      if (patch.reviewBlockingCount !== undefined) {
        job.reviewBlockingCount = patch.reviewBlockingCount;
      }
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
