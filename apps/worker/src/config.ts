import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
 * The four ways a run can be made to go wrong on demand.
 *
 * Milestone 1's pipeline is simulated, so without these the recovery machinery
 * would have nothing to recover from and the interesting paths would only ever
 * be exercised by unit tests with hand-thrown errors. Each mode maps to one
 * claim the milestone makes:
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
 *
 * All of it is deleted when the sandbox lands in Milestone 2.
 */
export const FAULT_MODES = ["throw", "fatal", "hang", "exit"] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export interface FaultConfig {
  /** The phase to fail, matched against a phase's status (e.g. `testing`). */
  phase: string;
  mode: FaultMode;
}

/**
 * Whether a job's phases do real work or pretend to.
 *
 * `off` selects `simulatedPipeline()` - seven sleeps, no Docker - which is what
 * the 27-test integration suite runs under, so that suite still needs only
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
  /** Cap on each of stdout and stderr, per command, before truncation. */
  maxOutputBytes: number;
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
  /** Fault injection, absent unless both env vars are set. */
  fault?: FaultConfig;
  /** What a phase with a real body runs in. */
  sandbox: SandboxConfig;
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
  SANDBOX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1_024).max(4_194_304).default(65_536),
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
      maxOutputBytes: parsed.data.SANDBOX_MAX_OUTPUT_BYTES,
    },
  };

  assertLeaseInvariant(config.heartbeatSeconds, config.leaseSeconds);
  assertRealSandboxInProduction(config.sandbox.mode, env.NODE_ENV);
  return config;
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
