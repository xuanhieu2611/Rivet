import { z } from "zod";

import {
  checkpointKindSchema,
  checkpointPatchCompressionSchema,
  checkpointPatchFormatSchema,
  type CheckpointKind,
  type CheckpointPatchCompression,
  type CheckpointPatchFormat,
} from "./checkpoint";
import {
  externalEffectKindSchema,
  publicationSkipReasonSchema,
  pullRequestStateSchema,
  type ExternalEffectKind,
  type PublicationSkipReason,
  type PullRequestState,
} from "./github";
import { jobStatusSchema, type JobStatus } from "./job";
import { artifactTypeSchema, type ArtifactType } from "./job-artifact";
import {
  reviewDecisionSchema,
  reviewModeSchema,
  type ReviewDecision,
  type ReviewMode,
} from "./review-report";
import type { CheckKind, CheckStatus } from "./validation-check";

/**
 * The vocabulary of the append-only job event log.
 *
 * Unlike `JOB_STATUSES`, this list is NOT a Postgres enum. Status is a closed
 * state machine that is indexed and queried on, so it earns a real enum plus a
 * drift assertion. Event types are a growing description of what happened, read
 * back only to render a timeline, and the list churns every milestone - paying
 * a migration per new entry buys nothing. The column is `text` and this schema
 * is the validation.
 */
export const JOB_EVENT_TYPES = [
  "job.created",
  "job.enqueued",
  /**
   * The row committed but the message did not land.
   *
   * The one visible symptom of the dual-write gap between Postgres and Redis.
   * It is not a failure of the job - the sweeper re-enqueues orphaned `queued`
   * rows - but it is worth seeing on the timeline when it happens.
   */
  "job.enqueue_failed",
  "job.claimed",
  "job.status_changed",
  "phase.started",
  "phase.completed",
  "job.cancel_requested",
  "job.retry_scheduled",
  /** The sweeper took the job back from a worker that went silent. */
  "job.reclaimed",
  /** A worker discovered it no longer owns the job and stood down. */
  "job.lease_lost",
  "job.failed",
  "job.completed",

  // --- sandbox execution (M2) ------------------------------------------
  /** A container exists and the job now owns something that has to be destroyed. */
  "sandbox.created",
  "sandbox.destroyed",
  /** One bounded resource snapshot was recorded before the container vanished. */
  "sandbox.resources_recorded",
  "repo.cloned",
  "deps.installed",
  /** A command is about to run inside the sandbox. */
  "command.started",
  /** A command finished inside the sandbox and its transcript was recorded. */
  "command.completed",
  /** The sandbox could not start or finish the command call. */
  "command.failed",
  /** One resolved validation check was recorded before implementation. */
  "baseline.check_recorded",
  /**
   * The repository's own test suite was run before anything was modified.
   *
   * A non-zero exit here is a recorded property of the repository, not a failed
   * job - see PRD §11 C.
   */
  "baseline.recorded",

  // --- coding agent (M4) -----------------------------------------------
  // Deliberately coarse. There is no event here for a token delta or for a
  // partial tool result, because Milestone 3's guarantee is at most one bounded
  // event query per second per viewer, and a row per streamed token would cost
  // that guarantee and produce a timeline nobody can read. A ten-minute session
  // should leave tens of rows behind, not thousands.
  /** A session exists: model, provider, and the tools it is actually holding. */
  "agent.session_started",
  "agent.turn_started",
  /** A model turn completed and is now eligible for an implementation checkpoint. */
  "agent.turn_completed",
  /** One completed assistant message, truncated to a preview. Never a delta. */
  "agent.message",
  /** The model called a tool. Carries `commandExecutionId` when that tool was the shell. */
  "agent.tool_started",
  "agent.tool_completed",
  /** One per turn, carrying what that turn cost. */
  "agent.usage",
  "agent.session_ended",
  /** A ceiling in the job's budget was reached and the session was stopped. */
  "agent.budget_exceeded",

  // --- validation and artifacts (M5) ------------------------------------
  /** Historical rows from the pre-M6 simulated planning body. */
  "plan.deferred",
  /** A durable output was persisted: its id, type and true byte size. Never its content. */
  "artifact.recorded",
  /** One validation check was compared with its own baseline. */
  "validation.check_recorded",
  /**
   * The test suite was re-run after the session and compared with the baseline.
   *
   * The outcome, not the exit code, because the interesting fact is the
   * comparison: a red suite that was already red before Rivet touched anything
   * is `unresolved`, and a red suite that used to be green is `regressed`.
   */
  "validation.recorded",
  /**
   * The closing line of a run: what the session did, and whether it worked.
   *
   * Written by `finalizing`, and it exists because the last thing on a timeline
   * used to be a phase saying it finished rather than a sentence saying what
   * happened. Distinct from `job.completed`, which the processor writes about
   * the *job* reaching a terminal status - a run can be summarized and then fail
   * to complete, and reading one off the other would make each of them less true.
   *
   * As of M8 it also carries `reviewDecision` and `reviewLoops`, because the
   * closing line of a run should say whether a second agent looked at it. On a
   * job that skipped review `reviewDecision` is absent rather than null: "no
   * reviewer looked at this" and "a reviewer had nothing to say" are different
   * facts.
   */
  "run.summarized",

  // --- planning and recovery (M6) --------------------------------------
  "plan.recorded",
  "checkpoint.created",
  "checkpoint.restored",
  "checkpoint.rejected",
  "run.resumed",

  // --- independent review (M8) ------------------------------------------
  /** A verdict was persisted, on every review including the one that ends the job. */
  "review.recorded",
  /** The verdict was `revise` and there was loop budget left, so the loop goes around again. */
  "review.revision_requested",
  /**
   * The last loop ended with blocking findings.
   *
   * Written immediately before the job fails `reviewer_rejection`, so the
   * timeline states that the bound was the reason rather than leaving a reader
   * to infer it from a failure category.
   */
  "review.limit_reached",
  /**
   * The job asked for `reviewMode: "none"`.
   *
   * A statement about the job's mode, never about the worker's configuration: a
   * pipeline built without an agent leaves `reviewing` a sleep and writes no
   * review event at all. The two absences are different facts.
   */
  "review.skipped",

  // --- GitHub publication (M9) -------------------------------------------
  /** The job's immutable repository binding was selected for this run. */
  "github.repository_bound",
  /** The deterministic publication branch was selected and persisted. */
  "branch.created",
  /** The validated tree was committed on the publication branch. */
  "commit.created",
  /** The publication branch was pushed or force-updated. */
  "push.completed",
  /** A new pull request was opened for the publication branch. */
  "pull_request.opened",
  /** An existing pull request was found and adopted. */
  "pull_request.adopted",
  /** Publication was intentionally skipped for a known reason. */
  "publication.skipped",
  /** An external-effect receipt was committed with its audit event. */
  "external_effect.recorded",
] as const;

export const jobEventTypeSchema = z.enum(JOB_EVENT_TYPES);

export type JobEventType = z.infer<typeof jobEventTypeSchema>;

/**
 * Why a job ended badly, from PRD §23.
 *
 * Same reasoning as `JOB_EVENT_TYPES`: `text` in Postgres, validated here.
 * `cancelled` is present because a cancellation is recorded with a category
 * even though a cancelled job is not a failed job.
 */
export const FAILURE_CATEGORIES = [
  "worker_crash",
  "lease_expired",
  "timed_out",
  "budget_exceeded",
  "cancelled",

  // --- sandbox execution (M2) ------------------------------------------
  // Retryable and terminal are not a property of this list - `classify()` in
  // `packages/core/src/jobs/failure.ts` is what decides, through the error class
  // each one is carried by. The comments here record the reasoning so the two
  // cannot drift silently.
  /** The Docker daemon is not reachable. Retryable: the daemon may come back. */
  "sandbox_unavailable",
  /** Image pull or container create failed. Retryable. */
  "sandbox_create_failed",
  /** Clone failed: 404, auth required, no such branch. Terminal - a 404 does not improve on retry. */
  "repo_unavailable",
  /** No `package.json`, no recognisable lockfile. Terminal. */
  "unsupported_project",
  /**
   * The install command exited non-zero. Terminal.
   *
   * A judgment call: an install failure is sometimes a transient registry blip,
   * but just as often a lockfile that disagrees with its `package.json`, which
   * would fail identically three times while burning three attempts and three
   * containers.
   */
  "dependency_install_failed",
  /** One command blew its own timeout. Distinct from the job blowing `max_duration_seconds`. */
  "command_timed_out",
  /** The container hit its memory limit. Terminal, and told apart from a generic 137 by `State.OOMKilled`. */
  "oom_killed",
  /**
   * The reaper found a container whose job is no longer live.
   *
   * Not a job outcome - nothing ever writes this to `jobs.failure_category`. It
   * exists so the reaper's log line names the same taxonomy everything else does.
   */
  "sandbox_leaked",

  // --- coding agent (M4) -----------------------------------------------
  /**
   * The model provider could not be reached or refused for a reason that may
   * pass: a 429, a 5xx, a dropped connection. Retryable, and the one failure in
   * this system whose cause is a third party's bad ten minutes.
   */
  "agent_unavailable",
  /**
   * The session cannot run as configured: a rejected key, a model id the
   * provider does not have, a harness that came up with the wrong tools.
   *
   * Terminal, because every one of those fails identically on the second
   * attempt while spending another container and another clone to find out.
   */
  "agent_failed",

  // --- validation (M5) --------------------------------------------------
  /**
   * The session ended cleanly having changed nothing.
   *
   * Terminal, and the most interesting failure this milestone can surface: a
   * model that believes it finished the task while the diff is empty did not do
   * the task, and it will do the same thing again on a second attempt.
   */
  "no_changes_produced",
  /**
   * The suite disagrees with the session: a green suite went red, or a red one
   * stayed red.
   *
   * Terminal. Re-running a whole model session on the chance of better sampling
   * costs another container, another clone and another bill to find out, and M6
   * is where resumption gets designed properly.
   */
  "validation_failed",
  /** A present `rivet.json` did not satisfy the strict validation contract. */
  "validation_config_invalid",

  // --- planning and recovery (M6) --------------------------------------
  /** The planner ended without submitting a valid structured plan. */
  "plan_not_produced",
  /** A stored checkpoint failed schema, size, or checksum validation. */
  "checkpoint_corrupt",
  /** A valid checkpoint could not be applied to the original base commit. */
  "checkpoint_restore_failed",
  /** The complete checkpoint exceeds the configured storage bound. */
  "checkpoint_too_large",

  // --- independent review (M8) ------------------------------------------
  /**
   * The reviewer session ended without submitting a valid structured verdict.
   *
   * Terminal, mirroring `plan_not_produced`. Treating a missing verdict as an
   * approval would be the one bug in this milestone nobody would ever notice.
   */
  "review_not_produced",
  /**
   * The last review loop still found something blocking. Terminal.
   *
   * Completing the job anyway would make review decorative, and the report that
   * rejected it stays readable on the failed job so the rejection is always
   * attributable to named findings.
   */
  "reviewer_rejection",

  // --- GitHub publication (M9) -------------------------------------------
  /** GitHub transport, server, or rate-limit failure after adapter retries. */
  "github_unavailable",
  /** The App cannot access the bound repository or installation. */
  "github_permission_denied",
  /** Git refused a publication branch update. */
  "push_rejected",
  /** The branch exists, but the pull request could not be opened. */
  "pull_request_failed",
  /** The job references an installation that is not available. */
  "github_not_installed",

  "unknown",
] as const;

export const failureCategorySchema = z.enum(FAILURE_CATEGORIES);

export type FailureCategory = z.infer<typeof failureCategorySchema>;

/**
 * Reads a `failure_category` column back into the enum.
 *
 * A value outside the list can only come from a newer version of Rivet writing
 * to the same database, so it degrades to `unknown` rather than to `null`:
 * "we do not recognise this failure" and "this did not fail" are different
 * facts and the UI renders them differently.
 */
export function parseFailureCategory(value: string | null | undefined): FailureCategory | null {
  if (value === null || value === undefined) return null;
  const parsed = failureCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

/**
 * What re-running the suite after the session established, relative to the
 * baseline.
 *
 * Five outcomes rather than a boolean, because the baseline is what gives the
 * second run its meaning:
 *
 * | baseline  | after  | outcome      | job    |
 * | --------- | ------ | ------------ | ------ |
 * | `passed`  | passes | `verified`   | green  |
 * | `passed`  | fails  | `regressed`  | failed |
 * | `failed`  | passes | `fixed`      | green  |
 * | `failed`  | fails  | `unresolved` | failed |
 * | `skipped` | n/a    | `unverified` | green  |
 *
 * `unverified` stays green deliberately: a repository with no `test` script is
 * not a broken job, and failing it would repeat exactly the mistake PRD §11 C
 * exists to prevent. It is recorded rather than omitted so nobody reads a green
 * badge as a claim that was never checked.
 */
export const VALIDATION_OUTCOMES = [
  "verified",
  "fixed",
  "regressed",
  "unresolved",
  "unverified",
] as const;

export const validationOutcomeSchema = z.enum(VALIDATION_OUTCOMES);

export type ValidationOutcome = z.infer<typeof validationOutcomeSchema>;

/**
 * The structured half of an event, stored in the `data` jsonb column.
 *
 * Written as a type alias rather than an interface on purpose: TypeScript gives
 * object type aliases an implicit index signature, which is what makes this
 * assignable to the loose `Record<string, unknown>` the Drizzle column is typed
 * as. The database package cannot import this type without making the
 * contracts -> database dependency circular.
 *
 * Every field is optional because different event types populate different
 * subsets: a status change carries `from`/`to`, a phase carries
 * `phase`/`durationMs`, a failure carries `error`/`failureCategory`.
 */
// The implicit index signature described above is exactly what an interface lacks.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type JobEventData = {
  /**
   * The status the job was actually in before the change.
   *
   * One concrete status, never the set of statuses a transition was willing to
   * accept - `transitionJob` reads it off the locked row for exactly this
   * reason. A timeline entry has to be a fact about this job.
   */
  from?: JobStatus;
  to?: JobStatus;
  phase?: string;
  durationMs?: number;
  /** `jobs.attempt_count` at the time, not BullMQ's per-message retry count. */
  attempt?: number;
  failureCategory?: FailureCategory;
  error?: string;
  /** The lease owner involved, for reclaim and fencing events. */
  leaseOwner?: string;

  // --- sandbox execution (M2) ------------------------------------------
  /** The container id, on `sandbox.created` / `sandbox.destroyed`. */
  containerId?: string;
  /** Resource report facts, on `sandbox.resources_recorded`. */
  resourceReportVersion?: number;
  samplingIntervalMs?: number;
  sampleCount?: number;
  samplingErrors?: number;
  inspectionErrors?: number;
  memoryPeakBytes?: number | null;
  memoryLimitBytes?: number;
  memoryPeakAtMs?: number | null;
  cpuPeakPercent?: number | null;
  cpuLimitNanoCpus?: number;
  cpuPeakAtMs?: number | null;
  pidsPeak?: number | null;
  pidsLimit?: number;
  pidsPeakAtMs?: number | null;
  oomKilled?: boolean;
  /** Null when the command was killed before it could exit. */
  exitCode?: number | null;
  /** Points at the `job_commands` row holding the transcript. */
  commandId?: number;
  /** The command as it was actually run. Never a shell string. */
  argv?: string[];
  /** Correlates the lifecycle events for one command attempt. */
  commandExecutionId?: string;
  /** The exact directory passed to the sandbox. */
  cwd?: string;
  /** The commit the clone resolved to, on `repo.cloned`. */
  commitSha?: string;
  /**
   * What the baseline run established, on `baseline.recorded`.
   *
   * Three outcomes rather than an exit code, because `skipped` is not one: a
   * repository with no `test` script produced no exit code at all, and reading
   * that off `exitCode: null` would collide with "the command was killed before
   * it could exit". `failed` is a fact about the repository and never a failed
   * job - PRD §11 C.
   */
  baseline?: "passed" | "failed" | "skipped";

  // --- coding agent (M4) -----------------------------------------------
  /** The harness's session id, on every `agent.*` row, so one job's sessions stay separable. */
  sessionId?: string;
  /** The explicit session role, so planner, implementer and reviewer runs stay distinguishable. */
  agentRole?: "planner" | "implementer" | "reviewer";
  /** The model id as configured, e.g. `deepseek/deepseek-v4-flash`. */
  model?: string;
  provider?: string;
  /**
   * The tools the session was actually holding, on `agent.session_started`.
   *
   * Recorded rather than assumed. The containment argument for running the
   * harness on the worker host rests entirely on this list being Rivet's four,
   * and a timeline that states what it was is the difference between believing
   * that and being able to check it afterwards.
   */
  toolNames?: string[];
  /** Which turn this belongs to, zero-based. */
  turn?: number;
  /** The cumulative completed-turn number across sessions for this job. */
  cumulativeTurn?: number;
  /** Bounded stderr from an internal checkpoint command rejection. */
  stderr?: string;
  /** How many turns the session took, on `agent.session_ended`. */
  turns?: number;
  toolName?: string;
  /** The harness's id for one tool call, pairing a start with its completion. */
  toolCallId?: string;
  /** Whether the tool reported an error. Not a job failure - the model reads it and reacts. */
  toolError?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Null when the model has no rate table, which is a different fact from zero.
   *
   * Zero would mean a turn that cost nothing; null means spend for this model
   * cannot be computed, which is also why a cost ceiling cannot be enforced
   * against it.
   */
  costUsd?: number | null;
  /** Why a session ended, on `agent.session_ended`. */
  stopReason?: "completed" | "aborted" | "budget" | "timeout" | "error";
  /** Which ceiling was hit, on `agent.budget_exceeded`. */
  budget?: "cost" | "model_calls" | "tool_calls" | "turns";
  /** What the value had reached, and what it was allowed to reach. */
  budgetValue?: number;
  budgetLimit?: number;

  // --- validation and artifacts (M5) ------------------------------------
  /** Points at the `job_artifacts` row holding the content, on `artifact.recorded`. */
  artifactId?: number;
  artifactType?: ArtifactType;
  /**
   * The artifact's true size before truncation.
   *
   * Deliberately not the length of what was stored: a 4MB diff kept as 256KB is
   * a fact the timeline should be able to state without fetching either.
   */
  byteSize?: number;
  /** Whether the stored content has a gap in the middle. Pairs with `byteSize`. */
  truncated?: boolean;
  /** The comparison outcome, on `validation.recorded`. */
  validation?: ValidationOutcome;
  /** The validation check described by a per-check event. */
  check?: CheckKind;
  /** The result of comparing this check with its own baseline. */
  checkOutcome?: ValidationOutcome;
  /** What running this check established before comparison. */
  checkStatus?: CheckStatus;
  /** Parsed test totals, when a reporter produced a usable result. */
  testsTotal?: number;
  testsFailed?: number;
  /** Attribution counts for the full test comparison. */
  newFailures?: number;
  preExistingFailures?: number;
  fixedFailures?: number;
  /** Paths selected for the non-binding targeted test run. */
  targetedPaths?: string[];
  /**
   * Parsed `git diff --cached --numstat` totals.
   *
   * `filesChanged` counts every changed path, including binary ones;
   * `insertions` and `deletions` sum only the countable rows, because
   * `--numstat` reports `-` for a binary file rather than a number. A diff of
   * one PNG is therefore one file and zero lines, which is the honest reading.
   */
  filesChanged?: number;
  insertions?: number;
  deletions?: number;

  // --- planning and recovery (M6) --------------------------------------
  /** The durable checkpoint row referenced by a recovery event. */
  checkpointId?: number;
  /** The per-job sequence used to select the newest checkpoint. */
  checkpointSequence?: number;
  /** Alias accepted by older event producers that use the column name directly. */
  sequence?: number;
  checkpointKind?: CheckpointKind;
  /** Alias for checkpointKind used by compact timeline payloads, or an external-effect kind. */
  kind?: CheckpointKind | ExternalEffectKind;
  completedPhase?: JobStatus;
  resumePhase?: JobStatus;
  /** The sandbox that produced or currently owns the checkpoint. */
  sandboxId?: string;
  /** Both names are useful on checkpoint.restored: source and replacement. */
  sourceSandboxId?: string;
  originalSandboxId?: string;
  replacementSandboxId?: string;
  patchFormat?: CheckpointPatchFormat;
  patchCompression?: CheckpointPatchCompression;
  patchSha256?: string;
  patchByteSize?: number;
  patchCompressedBytes?: number;
  /** The delivery generation associated with this event. */
  dispatchGeneration?: number;

  // --- independent review (M8) ------------------------------------------
  /** The verdict, on `review.recorded` and on `run.summarized`. */
  reviewDecision?: ReviewDecision;
  /**
   * Revisions already spent when this verdict was produced, zero-based.
   *
   * The first reviewer session on any job records `reviewLoop: 0`. It is
   * exactly `jobs.review_loops` as read at the top of the phase, which is what
   * makes it survive a crash: a replacement worker reads the same counter.
   */
  reviewLoop?: number;
  /** `jobs.review_loops` after the increment, and the loop count on `run.summarized`. */
  reviewLoops?: number;
  /** The job's own bound, `jobs.max_review_loops`. */
  maxReviewLoops?: number;
  /** How many findings the verdict considered blocking. Zero exactly when the decision is `approve`. */
  blockingCount?: number;
  nonBlockingCount?: number;
  /** The reviewer's self-reported confidence, 0 through 1. */
  confidence?: number;
  /** The job's review mode, on `review.skipped`. */
  reviewMode?: ReviewMode;

  // --- GitHub publication (M9) -------------------------------------------
  /** The installation and repository selected for publication. */
  installationId?: number;
  owner?: string;
  repo?: string;
  private?: boolean;
  issueNumber?: number;
  /** The deterministic publication branch and its base. */
  branch?: string;
  baseBranch?: string;
  baseCommitSha?: string;
  treeSha?: string;
  forced?: boolean;
  /** Pull request identity and state, on opened/adopted events. */
  number?: number;
  url?: string;
  state?: PullRequestState;
  bodyArtifactId?: number;
  updated?: boolean;
  /** Why publication was skipped rather than attempted. */
  reason?: PublicationSkipReason;
  /** External-effect receipt details. */
  externalId?: string;
  externalUrl?: string;
  adopted?: boolean;
};

/** One row of the job timeline. */
export interface JobEvent {
  /**
   * Globally monotonic across all jobs. Ordering within a job is what it is
   * for; Milestone 3 also uses it as the SSE `Last-Event-ID` cursor.
   */
  id: number;
  jobId: string;
  type: JobEventType;
  message: string;
  data: JobEventData | null;
  createdAt: Date;
}

/** The JSON shape sent by the events API and passed across a client boundary. */
export type SerializedJobEvent = Omit<JobEvent, "createdAt"> & { createdAt: string };

const safeEventIdSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Event id must be a safe integer.");

const eventDateSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Event date must be a valid ISO date.");

const jobEventDataSchema = z
  .object({
    from: jobStatusSchema.optional(),
    to: jobStatusSchema.optional(),
    phase: z.string().optional(),
    durationMs: z.number().finite().optional(),
    attempt: z.number().int().nonnegative().optional(),
    failureCategory: failureCategorySchema.optional(),
    error: z.string().optional(),
    leaseOwner: z.string().optional(),
    containerId: z.string().optional(),
    resourceReportVersion: z.number().int().positive().optional(),
    samplingIntervalMs: z.number().int().positive().optional(),
    sampleCount: z.number().int().nonnegative().optional(),
    samplingErrors: z.number().int().nonnegative().optional(),
    inspectionErrors: z.number().int().nonnegative().optional(),
    memoryPeakBytes: z.number().nonnegative().nullable().optional(),
    memoryLimitBytes: z.number().nonnegative().optional(),
    memoryPeakAtMs: z.number().nonnegative().nullable().optional(),
    cpuPeakPercent: z.number().nonnegative().nullable().optional(),
    cpuLimitNanoCpus: z.number().nonnegative().optional(),
    cpuPeakAtMs: z.number().nonnegative().nullable().optional(),
    pidsPeak: z.number().nonnegative().nullable().optional(),
    pidsLimit: z.number().nonnegative().optional(),
    pidsPeakAtMs: z.number().nonnegative().nullable().optional(),
    oomKilled: z.boolean().optional(),
    exitCode: z.number().int().nullable().optional(),
    commandId: safeEventIdSchema.optional(),
    argv: z.array(z.string()).optional(),
    commandExecutionId: z.string().optional(),
    cwd: z.string().optional(),
    commitSha: z.string().optional(),
    baseline: z.enum(["passed", "failed", "skipped"]).optional(),
    sessionId: z.string().optional(),
    agentRole: z.enum(["planner", "implementer", "reviewer"]).optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    toolNames: z.array(z.string()).optional(),
    turn: z.number().int().nonnegative().optional(),
    cumulativeTurn: z.number().int().positive().optional(),
    stderr: z.string().optional(),
    turns: z.number().int().nonnegative().optional(),
    toolName: z.string().optional(),
    toolCallId: z.string().optional(),
    toolError: z.boolean().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    // Nullable rather than merely optional: an absent cost and an
    // uncomputable one are different facts and the UI renders them
    // differently. Not an integer, obviously, and not constrained to be
    // positive - a provider that reports a credit should round-trip.
    costUsd: z.number().finite().nullable().optional(),
    stopReason: z.enum(["completed", "aborted", "budget", "timeout", "error"]).optional(),
    budget: z.enum(["cost", "model_calls", "tool_calls", "turns"]).optional(),
    budgetValue: z.number().finite().optional(),
    budgetLimit: z.number().finite().optional(),
    artifactId: safeEventIdSchema.optional(),
    artifactType: artifactTypeSchema.optional(),
    byteSize: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    validation: validationOutcomeSchema.optional(),
    check: z.enum(["targeted_test", "test", "typecheck", "lint"]).optional(),
    checkOutcome: validationOutcomeSchema.optional(),
    checkStatus: z.enum(["passed", "failed", "skipped"]).optional(),
    testsTotal: z.number().int().nonnegative().optional(),
    testsFailed: z.number().int().nonnegative().optional(),
    newFailures: z.number().int().nonnegative().optional(),
    preExistingFailures: z.number().int().nonnegative().optional(),
    fixedFailures: z.number().int().nonnegative().optional(),
    targetedPaths: z.array(z.string()).optional(),
    filesChanged: z.number().int().nonnegative().optional(),
    insertions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    checkpointId: safeEventIdSchema.optional(),
    checkpointSequence: z.number().int().positive().optional(),
    sequence: z.number().int().positive().optional(),
    checkpointKind: checkpointKindSchema.optional(),
    kind: z.union([checkpointKindSchema, externalEffectKindSchema]).optional(),
    completedPhase: jobStatusSchema.optional(),
    resumePhase: jobStatusSchema.optional(),
    sandboxId: z.string().min(1).optional(),
    sourceSandboxId: z.string().min(1).optional(),
    originalSandboxId: z.string().min(1).optional(),
    replacementSandboxId: z.string().min(1).optional(),
    patchFormat: checkpointPatchFormatSchema.optional(),
    patchCompression: checkpointPatchCompressionSchema.optional(),
    patchSha256: z.string().min(1).optional(),
    patchByteSize: z.number().int().nonnegative().optional(),
    patchCompressedBytes: z.number().int().nonnegative().optional(),
    dispatchGeneration: z.number().int().nonnegative().optional(),
    reviewDecision: reviewDecisionSchema.optional(),
    reviewLoop: z.number().int().nonnegative().optional(),
    reviewLoops: z.number().int().nonnegative().optional(),
    maxReviewLoops: z.number().int().nonnegative().optional(),
    blockingCount: z.number().int().nonnegative().optional(),
    nonBlockingCount: z.number().int().nonnegative().optional(),
    confidence: z.number().min(0).max(1).optional(),
    reviewMode: reviewModeSchema.optional(),
    installationId: z.number().int().positive().optional(),
    owner: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    private: z.boolean().optional(),
    issueNumber: z.number().int().positive().optional(),
    branch: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    baseCommitSha: z.string().min(1).optional(),
    treeSha: z.string().min(1).optional(),
    forced: z.boolean().optional(),
    number: z.number().int().positive().optional(),
    url: z.string().min(1).optional(),
    state: pullRequestStateSchema.optional(),
    bodyArtifactId: safeEventIdSchema.optional(),
    updated: z.boolean().optional(),
    reason: publicationSkipReasonSchema.optional(),
    externalId: z.string().min(1).optional(),
    externalUrl: z.string().min(1).optional(),
    adopted: z.boolean().optional(),
  })
  .passthrough();

const serializedJobEventSchema = z.object({
  id: safeEventIdSchema,
  jobId: z.string().min(1),
  type: jobEventTypeSchema,
  message: z.string(),
  data: jobEventDataSchema.nullable(),
  createdAt: eventDateSchema,
});

/** Converts a database event into the JSON shape used by the browser. */
export function serializeJobEvent(event: JobEvent): SerializedJobEvent {
  return { ...event, createdAt: event.createdAt.toISOString() };
}

/** Validates a JSON event and restores its in-memory `Date` value. */
export function parseSerializedJobEvent(value: unknown): JobEvent {
  const parsed = serializedJobEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid job event: ${parsed.error.message}`);
  }

  return {
    ...parsed.data,
    data: parsed.data.data === null ? null : normalizeJobEventData(parsed.data.data),
    createdAt: new Date(parsed.data.createdAt),
  };
}

function normalizeJobEventData(value: z.infer<typeof jobEventDataSchema>): JobEventData {
  const known: JobEventData = {
    ...(value.from === undefined ? {} : { from: value.from }),
    ...(value.to === undefined ? {} : { to: value.to }),
    ...(value.phase === undefined ? {} : { phase: value.phase }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    ...(value.attempt === undefined ? {} : { attempt: value.attempt }),
    ...(value.failureCategory === undefined ? {} : { failureCategory: value.failureCategory }),
    ...(value.error === undefined ? {} : { error: value.error }),
    ...(value.leaseOwner === undefined ? {} : { leaseOwner: value.leaseOwner }),
    ...(value.containerId === undefined ? {} : { containerId: value.containerId }),
    ...(value.resourceReportVersion === undefined
      ? {}
      : { resourceReportVersion: value.resourceReportVersion }),
    ...(value.samplingIntervalMs === undefined
      ? {}
      : { samplingIntervalMs: value.samplingIntervalMs }),
    ...(value.sampleCount === undefined ? {} : { sampleCount: value.sampleCount }),
    ...(value.samplingErrors === undefined ? {} : { samplingErrors: value.samplingErrors }),
    ...(value.inspectionErrors === undefined ? {} : { inspectionErrors: value.inspectionErrors }),
    ...(value.memoryPeakBytes === undefined ? {} : { memoryPeakBytes: value.memoryPeakBytes }),
    ...(value.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: value.memoryLimitBytes }),
    ...(value.memoryPeakAtMs === undefined ? {} : { memoryPeakAtMs: value.memoryPeakAtMs }),
    ...(value.cpuPeakPercent === undefined ? {} : { cpuPeakPercent: value.cpuPeakPercent }),
    ...(value.cpuLimitNanoCpus === undefined ? {} : { cpuLimitNanoCpus: value.cpuLimitNanoCpus }),
    ...(value.cpuPeakAtMs === undefined ? {} : { cpuPeakAtMs: value.cpuPeakAtMs }),
    ...(value.pidsPeak === undefined ? {} : { pidsPeak: value.pidsPeak }),
    ...(value.pidsLimit === undefined ? {} : { pidsLimit: value.pidsLimit }),
    ...(value.pidsPeakAtMs === undefined ? {} : { pidsPeakAtMs: value.pidsPeakAtMs }),
    ...(value.oomKilled === undefined ? {} : { oomKilled: value.oomKilled }),
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.commandId === undefined ? {} : { commandId: value.commandId }),
    ...(value.argv === undefined ? {} : { argv: value.argv }),
    ...(value.commandExecutionId === undefined
      ? {}
      : { commandExecutionId: value.commandExecutionId }),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.commitSha === undefined ? {} : { commitSha: value.commitSha }),
    ...(value.baseline === undefined ? {} : { baseline: value.baseline }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.agentRole === undefined ? {} : { agentRole: value.agentRole }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.toolNames === undefined ? {} : { toolNames: value.toolNames }),
    ...(value.turn === undefined ? {} : { turn: value.turn }),
    ...(value.cumulativeTurn === undefined ? {} : { cumulativeTurn: value.cumulativeTurn }),
    ...(value.stderr === undefined ? {} : { stderr: value.stderr }),
    ...(value.turns === undefined ? {} : { turns: value.turns }),
    ...(value.toolName === undefined ? {} : { toolName: value.toolName }),
    ...(value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId }),
    ...(value.toolError === undefined ? {} : { toolError: value.toolError }),
    ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
    ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
    ...(value.costUsd === undefined ? {} : { costUsd: value.costUsd }),
    ...(value.stopReason === undefined ? {} : { stopReason: value.stopReason }),
    ...(value.budget === undefined ? {} : { budget: value.budget }),
    ...(value.budgetValue === undefined ? {} : { budgetValue: value.budgetValue }),
    ...(value.budgetLimit === undefined ? {} : { budgetLimit: value.budgetLimit }),
    ...(value.artifactId === undefined ? {} : { artifactId: value.artifactId }),
    ...(value.artifactType === undefined ? {} : { artifactType: value.artifactType }),
    ...(value.byteSize === undefined ? {} : { byteSize: value.byteSize }),
    ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
    ...(value.validation === undefined ? {} : { validation: value.validation }),
    ...(value.check === undefined ? {} : { check: value.check }),
    ...(value.checkOutcome === undefined ? {} : { checkOutcome: value.checkOutcome }),
    ...(value.checkStatus === undefined ? {} : { checkStatus: value.checkStatus }),
    ...(value.testsTotal === undefined ? {} : { testsTotal: value.testsTotal }),
    ...(value.testsFailed === undefined ? {} : { testsFailed: value.testsFailed }),
    ...(value.newFailures === undefined ? {} : { newFailures: value.newFailures }),
    ...(value.preExistingFailures === undefined
      ? {}
      : { preExistingFailures: value.preExistingFailures }),
    ...(value.fixedFailures === undefined ? {} : { fixedFailures: value.fixedFailures }),
    ...(value.targetedPaths === undefined ? {} : { targetedPaths: value.targetedPaths }),
    ...(value.filesChanged === undefined ? {} : { filesChanged: value.filesChanged }),
    ...(value.insertions === undefined ? {} : { insertions: value.insertions }),
    ...(value.deletions === undefined ? {} : { deletions: value.deletions }),
    ...(value.checkpointId === undefined ? {} : { checkpointId: value.checkpointId }),
    ...(value.checkpointSequence === undefined
      ? {}
      : { checkpointSequence: value.checkpointSequence }),
    ...(value.sequence === undefined ? {} : { sequence: value.sequence }),
    ...(value.checkpointKind === undefined ? {} : { checkpointKind: value.checkpointKind }),
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.completedPhase === undefined ? {} : { completedPhase: value.completedPhase }),
    ...(value.resumePhase === undefined ? {} : { resumePhase: value.resumePhase }),
    ...(value.sandboxId === undefined ? {} : { sandboxId: value.sandboxId }),
    ...(value.sourceSandboxId === undefined ? {} : { sourceSandboxId: value.sourceSandboxId }),
    ...(value.originalSandboxId === undefined
      ? {}
      : { originalSandboxId: value.originalSandboxId }),
    ...(value.replacementSandboxId === undefined
      ? {}
      : { replacementSandboxId: value.replacementSandboxId }),
    ...(value.patchFormat === undefined ? {} : { patchFormat: value.patchFormat }),
    ...(value.patchCompression === undefined ? {} : { patchCompression: value.patchCompression }),
    ...(value.patchSha256 === undefined ? {} : { patchSha256: value.patchSha256 }),
    ...(value.patchByteSize === undefined ? {} : { patchByteSize: value.patchByteSize }),
    ...(value.patchCompressedBytes === undefined
      ? {}
      : { patchCompressedBytes: value.patchCompressedBytes }),
    ...(value.dispatchGeneration === undefined
      ? {}
      : { dispatchGeneration: value.dispatchGeneration }),
    ...(value.reviewDecision === undefined ? {} : { reviewDecision: value.reviewDecision }),
    ...(value.reviewLoop === undefined ? {} : { reviewLoop: value.reviewLoop }),
    ...(value.reviewLoops === undefined ? {} : { reviewLoops: value.reviewLoops }),
    ...(value.maxReviewLoops === undefined ? {} : { maxReviewLoops: value.maxReviewLoops }),
    ...(value.blockingCount === undefined ? {} : { blockingCount: value.blockingCount }),
    ...(value.nonBlockingCount === undefined ? {} : { nonBlockingCount: value.nonBlockingCount }),
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    ...(value.reviewMode === undefined ? {} : { reviewMode: value.reviewMode }),
    ...(value.installationId === undefined ? {} : { installationId: value.installationId }),
    ...(value.owner === undefined ? {} : { owner: value.owner }),
    ...(value.repo === undefined ? {} : { repo: value.repo }),
    ...(value.private === undefined ? {} : { private: value.private }),
    ...(value.issueNumber === undefined ? {} : { issueNumber: value.issueNumber }),
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    ...(value.baseBranch === undefined ? {} : { baseBranch: value.baseBranch }),
    ...(value.baseCommitSha === undefined ? {} : { baseCommitSha: value.baseCommitSha }),
    ...(value.treeSha === undefined ? {} : { treeSha: value.treeSha }),
    ...(value.forced === undefined ? {} : { forced: value.forced }),
    ...(value.number === undefined ? {} : { number: value.number }),
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(value.bodyArtifactId === undefined ? {} : { bodyArtifactId: value.bodyArtifactId }),
    ...(value.updated === undefined ? {} : { updated: value.updated }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.externalId === undefined ? {} : { externalId: value.externalId }),
    ...(value.externalUrl === undefined ? {} : { externalUrl: value.externalUrl }),
    ...(value.adopted === undefined ? {} : { adopted: value.adopted }),
  };
  const knownKeys = new Set(Object.keys(known));
  const extras = Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => !knownKeys.has(key) && entry !== undefined),
  );

  return Object.assign(known, extras);
}
