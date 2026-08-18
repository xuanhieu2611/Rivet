import type { JobQueue } from "@rivet/core";

import { type BullJobQueue, createBullJobQueue } from "./bull-queue";

/**
 * `@rivet/queue` - the only package in Rivet that knows Redis exists.
 *
 * `@rivet/core` declares the `JobQueue` port; this implements it twice, once
 * with BullMQ for the real system and once with an array for tests. Keeping the
 * adapter out of core is what lets the sentence "Postgres holds job state, Redis
 * only delivers messages" stay true at the level of the dependency graph rather
 * than just in a comment.
 *
 * The same laziness rule as `@rivet/database` applies: importing this package
 * never opens a connection and never throws, because `next build` runs in CI
 * with no `REDIS_URL`.
 */

export { closeRedis, getRedis } from "./connection";
export {
  BullJobQueue,
  createBullJobQueue,
  createJobRunQueue,
  DEFAULT_JOB_OPTIONS,
  SWEEP_JOB_OPTIONS,
} from "./bull-queue";
export { InMemoryJobQueue, type RecordedEnqueue } from "./memory-queue";
export {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_COMMAND_TIMEOUT_MS,
  getRateLimiter,
  RateLimitUnavailableError,
  RedisRateLimiter,
  type RateLimiter,
  type RateLimitResult,
} from "./rate-limiter";
export {
  encodeJobRunId,
  JOB_NAMES,
  type JobRunPayload,
  type JobRunsMessage,
  QUEUE_NAMES,
  SCHEDULER_IDS,
  type SweepPayload,
} from "./names";

/**
 * The shared queue handle, created on first use.
 *
 * Cached on `globalThis` outside production for the same reason the Redis
 * client is: Next.js re-evaluates server modules on every hot reload, and a
 * fresh `Queue` per edit means a fresh pair of connections per edit.
 */
const globalForQueue = globalThis as unknown as { __rivetJobQueue?: BullJobQueue };

let queue: BullJobQueue | undefined;

export function getJobQueue(): JobQueue {
  return getBullJobQueue();
}

/**
 * The same handle, typed as the adapter rather than the port.
 *
 * Only the worker needs this, and only to register the sweep scheduler - which
 * is a BullMQ concept with no place on the `JobQueue` interface. Everything
 * else, including every caller in `apps/web`, takes the port.
 */
export function getBullJobQueue(): BullJobQueue {
  queue ??= globalForQueue.__rivetJobQueue ?? createBullJobQueue();
  if (process.env.NODE_ENV !== "production") {
    globalForQueue.__rivetJobQueue = queue;
  }
  return queue;
}

/** Closes the shared queue. Only entrypoints and scripts call this. */
export async function closeJobQueue(): Promise<void> {
  const current = queue;
  queue = undefined;
  delete globalForQueue.__rivetJobQueue;
  if (current) {
    await current.close();
  }
}
