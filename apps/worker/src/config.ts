import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { reviewModeSchema, type ReviewMode } from "@rivet/contracts";
import { config as loadEnvFile } from "dotenv";
import { z } from "zod";

/**
 * The worker's configuration, parsed once at startup and never read again.
 *
 * `parseWorkerConfig` is a pure function of an environment object precisely so
 * that this file is unit-testable with no environment at all. Nothing here
 * reads `process.env` on its own; `index.ts` passes it in.
 *
 * The rule this exists to enforce is in `assertLeaseInvariant`. A worker that
 * boots with a heartbeat interval longer than a third of its lease will have
 * its jobs stolen out from under it by the sweeper while it is perfectly
 * healthy, and the resulting duplicate execution is miserable to diagnose
 * because nothing looks broken. Making that configuration impossible to start
 * is much cheaper than making it possible to debug.
 */

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The ways a run can be made to go wrong on demand.
 *
 * The original four modes exercise the lifecycle machinery. The sandbox modes
 * exercise the real command and provider failure categories without requiring a
 * caller to damage the host manually. Each mode maps to one claim the
 * milestone makes:
 *
 * - `throw` - a retryable error. Proves backoff and retry, and that
 *   `attempt_count` survives across attempts.
 * - `fatal` - a terminal error. Proves the job fails once and BullMQ does not
 *   retry it.
 * - `hang` - ignore the abort signal entirely. Proves the timeout is a real
 *   deadline rather than a polite request.
 * - `exit` - `process.exit(1)` mid-phase, with no cleanup whatsoever. This is
 *   `kill -9` on demand: the lease expires and the sweeper reclaims the job.
 *   It is the Milestone 6 demo, available five milestones early.
 * - `no-daemon` - sandbox creation raises `sandbox_unavailable`, which retries.
 * - `oom` - a sandbox command allocates until the memory limit kills it.
 * - `slow-command` - a sandbox command outlives its own timeout, distinct from
 *   the whole job deadline.
 */
export const FAULT_MODES = [
  "throw",
  "fatal",
  "hang",
  "exit",
  "no-daemon",
  "oom",
  "slow-command",
] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export interface FaultConfig {
  /** The phase to fail, matched against a phase's status (e.g. `testing`). */
  phase: string;
  mode: FaultMode;
}

/**
 * Whether a job's phases do real work or pretend to.
 *
 * `off` selects `simulatedPipeline()` - seven phases with no Docker - which is what
 * the integration suite runs under, so that suite still needs only
 * Postgres and Redis. It is a legitimate configuration for a machine with no
 * daemon and an illegitimate one for a deployment, which is why
 * `parseWorkerConfig` refuses it when `NODE_ENV=production` rather than merely
 * discouraging it. A worker that silently pretends to do work is the kind of
 * thing that should be impossible to configure.
 */
export const SANDBOX_MODES = ["docker", "off"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/**
 * The sandbox image, pinned by digest as well as by tag.
 *
 * Both halves are load-bearing. The tag is what a human reads; the digest is
 * what stops an upstream retag silently changing what a job runs. This
 * particular digest is an OCI image index covering `arm64` and `amd64`, so one
 * pin resolves on Apple silicon and on CI's amd64 runners.
 *
 * Not `-slim`, and it is not a preference: the slim image ships no `git`, so
 * the first thing `provisioning` does fails with `executable file not found`
 * and gets reported as `repo_unavailable` - Rivet blaming the repository for
 * its own missing tool. The container runs as uid 1000 with
 * `no-new-privileges`, so installing git on the way in is not available either.
 */
export const DEFAULT_SANDBOX_IMAGE =
  "node@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584";

/**
 * Where the clone lands, and why it is under `/home/node` rather than `/`.
 *
 * Docker creates a missing working directory as root and does not chown it to
 * the user the container runs as, so the workdir's parent has to already be
 * writable by uid 1000. `/home/node` is; `/` is not.
 */
export const DEFAULT_SANDBOX_WORKDIR = "/home/node/workspace";

export interface SandboxConfig {
  mode: SandboxMode;
  image: string;
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
  /** The repository's own suite, which is allowed to be slow without being wrong. */
  baselineTimeoutMs: number;
  /** The per-command budget for lint and typecheck checks. */
  checkTimeoutMs: number;
  /** Cap on each of stdout and stderr, per command, before truncation. */
  maxOutputBytes: number;
  /**
   * Cap on one `git diff` read, which is deliberately not `maxOutputBytes`.
   *
   * The ordinary cap is tuned for transcripts and sits below the artifact bound,
   * so reading a diff through it would clip the diff before `recordArtifact`
   * ever saw it - and the stored `byte_size` would then record the clipped
   * length as the true one. Keep this above `RIVET_ARTIFACT_MAX_BYTES` so that
   * truncation is the artifact writer's decision and stays honest about what it
   * truncated.
   */
  diffMaxBytes: number;
  /** Cap on one complete JSON reporter file read from the sandbox. */
  validationReportMaxBytes: number;
  /** Maximum number of files passed to one targeted test invocation. */
  targetedMaxFiles: number;
  /**
   * How old a container must be before the reaper will consider it abandoned.
   *
   * A grace period rather than zero because the reaper asks Postgres whether a
   * container's job is still running, and a container created moments ago may
   * belong to a job whose row has not yet been written - reaping that is the
   * reaper causing the exact failure it exists to clean up after. Two minutes
   * in production; `pnpm demo:recovery` compresses it so the orphan a killed
   * worker left behind is provably gone before the demo ends.
   */
  reapGraceMs: number;
}

/**
 * Whether `implementing` runs a real coding session or the Milestone 1 sleep.
 *
 * Exactly the `RIVET_SANDBOX` rule, for exactly the same reason. `off` is what
 * the integration suite and a laptop with no model key run under, and it is a
 * legitimate answer in both places; in production it would mean every job
 * sleeping through the one phase that is supposed to do the work while
 * reporting `completed`, which is the worst failure mode on offer.
 *
 * `scripted` is the third answer and the narrowest: it loads a `CodingAgent`
 * from a module path and calls no provider at all. It exists for
 * `pnpm demo:recovery`, which has to prove that a killed worker's work is
 * restored rather than that a model can be sampled twice and reach the same
 * place. It is refused in production for the same reason `off` is - a
 * deployment whose sessions are canned is a deployment doing no work.
 */
export const AGENT_MODES = ["pi", "off", "scripted"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/**
 * The default model, and the reason it is this one.
 *
 * Cheap enough that a debugging loop is not a budget conversation, present in
 * the harness's own catalog with its rates - which is what makes a cost ceiling
 * enforceable rather than aspirational - and trivially swappable for the model
 * experiments Milestone 10 wants.
 */
export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
export const DEFAULT_MODEL_PROVIDER = "openrouter";

export interface AgentConfig {
  mode: AgentMode;
  model: string;
  provider: string;
  /** The session's own deadline, distinct from the job's `max_duration_seconds`. */
  sessionTimeoutMs: number;
  maxTurns: number;
  /** What one shell command may hand back to the *model*, not what is stored. */
  toolOutputMaxBytes: number;
  /** Cap on one file read out of the sandbox. */
  fileMaxBytes: number;
  /** Cap on any single piece of session text that reaches the timeline. */
  previewMaxBytes: number;
  /**
   * A Rivet-owned configuration directory for the harness.
   *
   * Deliberately not `~/.pi`: a harness pointed at a developer's own config
   * directory silently mixes that developer's machine into every job the worker
   * runs, which makes a run unreproducible and is close to the most confusing
   * bug available here.
   */
  homeDir: string;
  /**
   * The module that supplies the agent under `RIVET_AGENT=scripted`.
   *
   * Present only in that mode, and required by it: a scripted mode with no
   * script would be a worker that says it has an agent and does not.
   */
  scriptPath?: string;
}

/**
 * How many heartbeats must be missed before a lease lapses.
 *
 * Three, so that one slow query and one dropped packet are both survivable. Two
 * would make a single hiccup enough; ten would mean a genuinely dead worker
 * holds its job for minutes.
 */
export const HEARTBEATS_PER_LEASE = 3;

export interface WorkerConfig {
  /** Jobs this worker runs at once. */
  concurrency: number;
  /** How long a claim is good for without a heartbeat. */
  leaseSeconds: number;
  /** How often the lease is renewed, and cancellation is checked. */
  heartbeatSeconds: number;
  /** How often this worker asks the scheduler to run a reconciliation pass. */
  sweepIntervalMs: number;
  /**
   * Claims a job gets before the sweeper stops reclaiming it and fails it.
   *
   * Postgres's ceiling, not BullMQ's: it counts crashes and reclaims that
   * BullMQ never heard about, which is the whole reason it exists separately.
   */
  maxAttempts: number;
  /** Scales every simulated phase duration. 0 makes a run instant. */
  pipelineSpeed: number;
  /** Default review mode used when a worker-side job creator omits it. */
  reviewMode: ReviewMode;
  /** Default maximum number of review revisions for a newly-created job. */
  maxReviewLoops: number;
  /**
   * Cap on one stored artifact - a diff, a summary - before truncation.
   *
   * Its own bound rather than `SANDBOX_MAX_OUTPUT_BYTES`, because a command
   * transcript is a log and an artifact is the run's work product. Not a
   * constant in `@rivet/core` either: that package holds no policy, and a
   * default limit living there is how something ends up unbounded in one
   * deployment and not another.
   */
  artifactMaxBytes: number;
  /** Maximum complete compressed checkpoint payload stored in Postgres. */
  checkpointMaxBytes: number;
  /** Budget for capturing a workspace patch at a safe boundary. */
  checkpointTimeoutMs: number;
  /** Fault injection, absent unless both env vars are set. */
  fault?: FaultConfig;
  /** What a phase with a real body runs in. */
  sandbox: SandboxConfig;
  /** What runs the `implementing` phase, and the ceilings it runs under. */
  agent: AgentConfig;
  /** How long to wait for in-flight jobs on SIGTERM before forcing an exit. */
  shutdownGraceMs: number;
  logLevel: LogLevel;
}

const schema = z.object({
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(5).max(3_600).default(30),
  WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(600).default(10),
  // 60 seconds, not 10. A sweep is a Postgres query on a schedule, and Neon's
  // compute endpoint does not autosuspend while something keeps querying it -
  // so a chattier sweeper quietly spends the free tier's monthly compute
  // allowance on finding nothing. The floor is 1s for the integration suite.
  WORKER_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  RIVET_PIPELINE_SPEED: z.coerce.number().min(0).max(100).default(1),
  // Review is a job default, not a run-time switch. A job records these values
  // when it is created, so a replacement worker cannot change its workflow.
  RIVET_REVIEW_MODE: reviewModeSchema.default("independent"),
  RIVET_MAX_REVIEW_LOOPS: z.coerce.number().int().min(0).max(5).default(2),
  // 256KB, which holds a large refactor's diff whole. The ceiling is 8MB
  // because `content` is a Postgres `text` column read back by a page render,
  // not object storage.
  RIVET_ARTIFACT_MAX_BYTES: z.coerce.number().int().min(1_024).max(8_388_608).default(262_144),
  // Checkpoints are complete gzip payloads, never head/tail truncated. The
  // bound is deliberately larger than a normal source diff but still finite.
  RIVET_CHECKPOINT_MAX_BYTES: z.coerce.number().int().min(1_024).max(67_108_864).default(4_194_304),
  RIVET_CHECKPOINT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  RIVET_FAULT_PHASE: z.string().min(1).optional(),
  RIVET_FAULT_MODE: z.enum(FAULT_MODES).optional(),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

  // --- sandbox (M2) ----------------------------------------------------
  RIVET_SANDBOX: z.enum(SANDBOX_MODES).default("docker"),
  SANDBOX_IMAGE: z.string().min(1).default(DEFAULT_SANDBOX_IMAGE),
  SANDBOX_WORKDIR: z.string().startsWith("/").default(DEFAULT_SANDBOX_WORKDIR),
  SANDBOX_MEMORY_MB: z.coerce.number().int().min(256).max(65_536).default(2_048),
  // Fractional on purpose: half a core is a reasonable thing to ask for, and
  // `NanoCpus` is the integer that comes out the other end.
  SANDBOX_CPUS: z.coerce.number().min(0.1).max(64).default(2),
  SANDBOX_PIDS_LIMIT: z.coerce.number().int().min(16).max(65_536).default(512),
  SANDBOX_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
  SANDBOX_CLONE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(180_000),
  SANDBOX_INSTALL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
  SANDBOX_BASELINE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
  SANDBOX_CHECK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(180_000),
  SANDBOX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1_024).max(4_194_304).default(65_536),
  // 1MB, four times the artifact bound, so that a diff big enough to be
  // truncated is truncated by the artifact writer - which records how big it
  // really was - rather than by the container's transcript cap, which does not.
  RIVET_DIFF_MAX_BYTES: z.coerce.number().int().min(1_024).max(16_777_216).default(1_048_576),
  RIVET_VALIDATION_REPORT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(16_777_216)
    .default(4_194_304),
  RIVET_TARGETED_MAX_FILES: z.coerce.number().int().min(1).max(200).default(25),
  SANDBOX_REAP_GRACE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),

  // --- coding agent (M4) -----------------------------------------------
  RIVET_AGENT: z.enum(AGENT_MODES).default("pi"),
  RIVET_MODEL: z.string().min(1).default(DEFAULT_MODEL),
  RIVET_MODEL_PROVIDER: z.string().min(1).default(DEFAULT_MODEL_PROVIDER),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  AGENT_SESSION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(7_200_000).default(900_000),
  AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(1_000).default(40),
  AGENT_TOOL_OUTPUT_MAX_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(32_768),
  AGENT_FILE_MAX_BYTES: z.coerce.number().int().min(1_024).max(8_388_608).default(262_144),
  AGENT_PREVIEW_MAX_BYTES: z.coerce.number().int().min(128).max(65_536).default(2_048),
  AGENT_HOME_DIR: z.string().min(1).default(join(tmpdir(), "rivet-pi")),
  RIVET_AGENT_SCRIPT: z.string().min(1).optional(),
});

/** Every problem with the environment at once, rather than one per restart. */
export class WorkerConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid worker configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "WorkerConfigError";
  }
}

/**
 * The invariant, stated separately so the test reads like the rule.
 *
 * With the default 10 and 30: a worker may miss two heartbeats and still hold
 * its job. Miss three and the sweeper is entitled to conclude it is dead, which
 * is exactly what it should conclude.
 */
export function assertLeaseInvariant(heartbeatSeconds: number, leaseSeconds: number): void {
  if (heartbeatSeconds * HEARTBEATS_PER_LEASE > leaseSeconds) {
    throw new WorkerConfigError([
      `WORKER_HEARTBEAT_SECONDS (${heartbeatSeconds}) * ${HEARTBEATS_PER_LEASE} must be at most ` +
        `WORKER_LEASE_SECONDS (${leaseSeconds}). Otherwise a healthy worker's lease can lapse ` +
        `between two heartbeats and its job will be reclaimed while it is still running.`,
    ]);
  }
}

export function parseWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  // An env var set to the empty string means "unset" here. Zod's coercion would
  // otherwise turn `WORKER_CONCURRENCY=""` into 0, and a `.env` file full of
  // blank placeholders is a completely normal thing to have.
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );

  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    throw new WorkerConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  const fault = parseFault(parsed.data.RIVET_FAULT_PHASE, parsed.data.RIVET_FAULT_MODE);

  const config: WorkerConfig = {
    concurrency: parsed.data.WORKER_CONCURRENCY,
    leaseSeconds: parsed.data.WORKER_LEASE_SECONDS,
    heartbeatSeconds: parsed.data.WORKER_HEARTBEAT_SECONDS,
    sweepIntervalMs: parsed.data.WORKER_SWEEP_INTERVAL_MS,
    maxAttempts: parsed.data.WORKER_MAX_ATTEMPTS,
    pipelineSpeed: parsed.data.RIVET_PIPELINE_SPEED,
    reviewMode: parsed.data.RIVET_REVIEW_MODE,
    maxReviewLoops: parsed.data.RIVET_MAX_REVIEW_LOOPS,
    artifactMaxBytes: parsed.data.RIVET_ARTIFACT_MAX_BYTES,
    checkpointMaxBytes: parsed.data.RIVET_CHECKPOINT_MAX_BYTES,
    checkpointTimeoutMs: parsed.data.RIVET_CHECKPOINT_TIMEOUT_MS,
    // `exactOptionalPropertyTypes` is on, so an absent fault has to be an
    // absent key rather than an explicit `undefined`.
    ...(fault ? { fault } : {}),
    shutdownGraceMs: parsed.data.WORKER_SHUTDOWN_GRACE_MS,
    logLevel: parsed.data.LOG_LEVEL,
    sandbox: {
      mode: parsed.data.RIVET_SANDBOX,
      image: parsed.data.SANDBOX_IMAGE,
      workdir: parsed.data.SANDBOX_WORKDIR,
      memoryBytes: parsed.data.SANDBOX_MEMORY_MB * 1_024 * 1_024,
      // Docker's unit for a CPU quota is a billionth of one, and it wants an
      // integer.
      nanoCpus: Math.round(parsed.data.SANDBOX_CPUS * 1_000_000_000),
      pidsLimit: parsed.data.SANDBOX_PIDS_LIMIT,
      commandTimeoutMs: parsed.data.SANDBOX_COMMAND_TIMEOUT_MS,
      cloneTimeoutMs: parsed.data.SANDBOX_CLONE_TIMEOUT_MS,
      installTimeoutMs: parsed.data.SANDBOX_INSTALL_TIMEOUT_MS,
      baselineTimeoutMs: parsed.data.SANDBOX_BASELINE_TIMEOUT_MS,
      checkTimeoutMs: parsed.data.SANDBOX_CHECK_TIMEOUT_MS,
      maxOutputBytes: parsed.data.SANDBOX_MAX_OUTPUT_BYTES,
      diffMaxBytes: parsed.data.RIVET_DIFF_MAX_BYTES,
      validationReportMaxBytes: parsed.data.RIVET_VALIDATION_REPORT_MAX_BYTES,
      targetedMaxFiles: parsed.data.RIVET_TARGETED_MAX_FILES,
      reapGraceMs: parsed.data.SANDBOX_REAP_GRACE_MS,
    },
    agent: {
      mode: parsed.data.RIVET_AGENT,
      model: parsed.data.RIVET_MODEL,
      provider: parsed.data.RIVET_MODEL_PROVIDER,
      sessionTimeoutMs: parsed.data.AGENT_SESSION_TIMEOUT_MS,
      maxTurns: parsed.data.AGENT_MAX_TURNS,
      toolOutputMaxBytes: parsed.data.AGENT_TOOL_OUTPUT_MAX_BYTES,
      fileMaxBytes: parsed.data.AGENT_FILE_MAX_BYTES,
      previewMaxBytes: parsed.data.AGENT_PREVIEW_MAX_BYTES,
      homeDir: parsed.data.AGENT_HOME_DIR,
      ...parseAgentScript(parsed.data.RIVET_AGENT, parsed.data.RIVET_AGENT_SCRIPT),
    },
  };

  assertLeaseInvariant(config.heartbeatSeconds, config.leaseSeconds);
  assertArtifactReadLimits(
    config.artifactMaxBytes,
    config.sandbox.diffMaxBytes,
    config.sandbox.validationReportMaxBytes,
  );
  assertRealSandboxInProduction(config.sandbox.mode, env.NODE_ENV);
  assertRealAgentInProduction(config.agent.mode, env.NODE_ENV);
  assertModelKeyPresent(config.agent, parsed.data.OPENROUTER_API_KEY);
  return config;
}

/** Ensures complete sandbox reads reach the artifact writer before truncation. */
export function assertArtifactReadLimits(
  artifactMaxBytes: number,
  diffMaxBytes: number,
  validationReportMaxBytes: number,
): void {
  const problems: string[] = [];
  if (diffMaxBytes <= artifactMaxBytes) {
    problems.push(
      `RIVET_DIFF_MAX_BYTES (${diffMaxBytes}) must be greater than ` +
        `RIVET_ARTIFACT_MAX_BYTES (${artifactMaxBytes}).`,
    );
  }
  if (validationReportMaxBytes <= artifactMaxBytes) {
    problems.push(
      `RIVET_VALIDATION_REPORT_MAX_BYTES (${validationReportMaxBytes}) must be greater than ` +
        `RIVET_ARTIFACT_MAX_BYTES (${artifactMaxBytes}).`,
    );
  }
  if (problems.length > 0) throw new WorkerConfigError(problems);
}

/**
 * A deployment may not pretend to do work.
 *
 * `RIVET_SANDBOX=off` is how the integration suite and a laptop with no daemon
 * run the pipeline, and it is a perfectly good answer in both places. In
 * production it would mean every job sleeping for twenty-one seconds and
 * reporting `completed` - a system that looks entirely healthy while doing
 * nothing at all, which is the worst failure mode available. Refusing to boot
 * is the cheap version of that conversation.
 */
export function assertRealSandboxInProduction(mode: SandboxMode, nodeEnv?: string): void {
  if (mode === "off" && nodeEnv === "production") {
    throw new WorkerConfigError([
      "RIVET_SANDBOX=off runs the simulated pipeline, which cannot be used with " +
        "NODE_ENV=production: every job would complete without doing any work. " +
        "Set RIVET_SANDBOX=docker, or run this worker outside production.",
    ]);
  }
}

/**
 * A deployment may not pretend to write code either.
 *
 * The sandbox rule, restated for the phase that is the whole point of the
 * system. `RIVET_AGENT=off` leaves `implementing` as a five-second sleep, which
 * is right for a laptop with no key and for the integration suite, and in
 * production would mean every job completing without having changed anything.
 */
export function assertRealAgentInProduction(mode: AgentMode, nodeEnv?: string): void {
  if (mode === "off" && nodeEnv === "production") {
    throw new WorkerConfigError([
      "RIVET_AGENT=off leaves the implementing phase simulated, which cannot be used with " +
        "NODE_ENV=production: every job would complete without writing any code. " +
        "Set RIVET_AGENT=pi, or run this worker outside production.",
    ]);
  }
  if (mode === "scripted" && nodeEnv === "production") {
    throw new WorkerConfigError([
      "RIVET_AGENT=scripted replays a canned session from RIVET_AGENT_SCRIPT, which cannot be " +
        "used with NODE_ENV=production: every job would complete having written whatever that " +
        "script says rather than what a model decided. It exists for pnpm demo:recovery. " +
        "Set RIVET_AGENT=pi, or run this worker outside production.",
    ]);
  }
}

/**
 * `RIVET_AGENT_SCRIPT` and `RIVET_AGENT=scripted` need each other.
 *
 * The same argument as `parseFault`, and the same two silent failures: a
 * scripted mode with no module has no session to run, and a module named
 * without the mode looks armed while `pi` quietly calls the real provider -
 * which is the expensive direction of that mistake.
 */
function parseAgentScript(
  mode: AgentMode,
  scriptPath: string | undefined,
): { scriptPath?: string } {
  if (mode === "scripted") {
    if (!scriptPath) {
      throw new WorkerConfigError([
        "RIVET_AGENT=scripted needs RIVET_AGENT_SCRIPT: the path to a module exporting " +
          "createCodingAgent(). Without it there is no session for the implementing phase to run.",
      ]);
    }
    return { scriptPath };
  }

  if (scriptPath !== undefined) {
    throw new WorkerConfigError([
      `RIVET_AGENT_SCRIPT is set but RIVET_AGENT is ${mode}, so the script would be ignored. ` +
        "Set RIVET_AGENT=scripted to run it, or unset RIVET_AGENT_SCRIPT.",
    ]);
  }
  return {};
}

/**
 * A worker that cannot reach a model provider should say so now.
 *
 * The same argument as the lease invariant: discovering a missing key on the
 * first job, after provisioning a container, cloning a repository and
 * installing its dependencies, is a slow and expensive way to learn something a
 * startup check answers instantly - and it burns an attempt doing it.
 *
 * Only OpenRouter is checked because only OpenRouter is configured. A different
 * provider is a different variable and belongs to whoever adds one.
 */
export function assertModelKeyPresent(agent: AgentConfig, apiKey?: string): void {
  if (agent.mode !== "pi") return;
  if (agent.provider !== DEFAULT_MODEL_PROVIDER) return;
  if (apiKey) return;

  throw new WorkerConfigError([
    `RIVET_AGENT=pi with RIVET_MODEL_PROVIDER=${DEFAULT_MODEL_PROVIDER} needs OPENROUTER_API_KEY. ` +
      "Without it every job would provision a sandbox, clone its repository and only then fail " +
      "to start a session. Set the key, or set RIVET_AGENT=off to run the simulated phase.",
  ]);
}

/**
 * Fault injection is opt-in and needs both halves.
 *
 * Half-configured is rejected rather than ignored, because both single-variable
 * mistakes are silent in the worst way: a mode with no phase would fail an
 * unpredictable phase, and a phase with no mode would look armed while doing
 * nothing at all. Someone reaching for this is trying to break a job on
 * purpose, and a demo that quietly does not break is worse than one that
 * refuses to start.
 */
function parseFault(phase: string | undefined, mode: FaultMode | undefined): FaultConfig | null {
  if (phase === undefined && mode === undefined) return null;
  if (phase === undefined || mode === undefined) {
    throw new WorkerConfigError([
      "RIVET_FAULT_PHASE and RIVET_FAULT_MODE must be set together: " +
        `got phase=${phase ?? "(unset)"}, mode=${mode ?? "(unset)"}.`,
    ]);
  }
  return { phase, mode };
}

/**
 * Loads the repo-root `.env.local`, the same file the web app reads.
 *
 * Rivet keeps one env file at the workspace root so the web app, drizzle-kit
 * and this worker cannot drift apart on which database they mean. Next.js only
 * looks inside its own project directory and solves this in `next.config.ts`;
 * this is the worker's half of the same trick. Values already in `process.env`
 * win, so a real deployment is unaffected.
 *
 * Called from `index.ts`, never at import time: `parseWorkerConfig` has to stay
 * a pure function for the tests.
 */
export function loadRootEnv(from: string = import.meta.dirname): void {
  let directory = resolve(from);
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      loadEnvFile({ path: [join(directory, ".env.local"), join(directory, ".env")], quiet: true });
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
