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
  /** Scales every simulated phase duration. 0 makes a run instant. */
  pipelineSpeed: number;
  /** How long to wait for in-flight jobs on SIGTERM before forcing an exit. */
  shutdownGraceMs: number;
  logLevel: LogLevel;
}

const schema = z.object({
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(5).max(3_600).default(30),
  WORKER_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(600).default(10),
  RIVET_PIPELINE_SPEED: z.coerce.number().min(0).max(100).default(1),
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
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

  const config: WorkerConfig = {
    concurrency: parsed.data.WORKER_CONCURRENCY,
    leaseSeconds: parsed.data.WORKER_LEASE_SECONDS,
    heartbeatSeconds: parsed.data.WORKER_HEARTBEAT_SECONDS,
    pipelineSpeed: parsed.data.RIVET_PIPELINE_SPEED,
    shutdownGraceMs: parsed.data.WORKER_SHUTDOWN_GRACE_MS,
    logLevel: parsed.data.LOG_LEVEL,
  };

  assertLeaseInvariant(config.heartbeatSeconds, config.leaseSeconds);
  return config;
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
