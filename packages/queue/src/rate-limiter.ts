import type { Redis } from "ioredis";

import { getRedis } from "./connection";

/** The result of one atomic fixed-window consume operation. */
export interface RateLimitResult {
  allowed: boolean;
  /** Unix epoch milliseconds at which this fixed window resets. */
  resetAt: number;
  /** Number of tokens still available in the current window. */
  remaining: number;
}

/** A small port that keeps the web app testable without a Redis server. */
export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

/** Redis could not answer, so callers must refuse rather than fail open. */
export class RateLimitUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Rate limiting is unavailable.", options);
    this.name = "RateLimitUnavailableError";
  }
}

/**
 * One Lua transaction implements a fixed window without a read-then-write gap.
 * Redis supplies the clock, so multiple web processes agree on the bucket and
 * callers can return an honest reset time.
 */
const CONSUME_SCRIPT = `
local now = redis.call("TIME")
local milliseconds = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local window = tonumber(ARGV[2])
local bucket = math.floor(milliseconds / window)
local bucketKey = KEYS[1] .. ":" .. bucket
local current = redis.call("INCR", bucketKey)
if current == 1 then
  redis.call("PEXPIRE", bucketKey, window * 2)
end
local resetAt = (bucket + 1) * window
local remaining = math.max(tonumber(ARGV[1]) - current, 0)
if current > tonumber(ARGV[1]) then
  return { 0, resetAt, 0 }
end
return { 1, resetAt, remaining }
`;

interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

export const DEFAULT_RATE_LIMIT_COMMAND_TIMEOUT_MS = 1_000;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisEvalClient,
    private readonly commandTimeoutMs = DEFAULT_RATE_LIMIT_COMMAND_TIMEOUT_MS,
  ) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Rate-limit limit must be a positive integer.");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) {
      throw new RangeError("Rate-limit window must be at least one second.");
    }

    let result: unknown;
    try {
      result = await withTimeout(
        this.redis.eval(CONSUME_SCRIPT, 1, key, String(limit), String(windowMs)),
        this.commandTimeoutMs,
      );
    } catch (cause) {
      throw new RateLimitUnavailableError({ cause });
    }

    if (!Array.isArray(result) || result.length !== 3) {
      throw new RateLimitUnavailableError({
        cause: new Error("Redis returned an invalid rate-limit result."),
      });
    }

    const allowed = Number(result[0]);
    const resetAt = Number(result[1]);
    const remaining = Number(result[2]);
    if (
      !Number.isFinite(allowed) ||
      !Number.isFinite(resetAt) ||
      !Number.isFinite(remaining) ||
      (allowed !== 0 && allowed !== 1) ||
      resetAt < 0 ||
      remaining < 0
    ) {
      throw new RateLimitUnavailableError({
        cause: new Error("Redis returned malformed rate-limit values."),
      });
    }

    return { allowed: allowed === 1, resetAt, remaining };
  }
}

/** Creates a limiter lazily, preserving the package's no-connection-on-import rule. */
export function createRateLimiter(redis: Redis = getRedisForRateLimiter()): RateLimiter {
  return new RedisRateLimiter(redis);
}

let limiter: RateLimiter | undefined;
const globalForRateLimiter = globalThis as unknown as { __rivetRateLimiter?: RateLimiter };

/** Shared web limiter. The Redis connection is still opened only on first use. */
export function getRateLimiter(): RateLimiter {
  try {
    limiter ??= globalForRateLimiter.__rivetRateLimiter ?? createRateLimiter();
    if (process.env.NODE_ENV !== "production") {
      globalForRateLimiter.__rivetRateLimiter = limiter;
    }
    return limiter;
  } catch (cause) {
    throw new RateLimitUnavailableError({ cause });
  }
}

/**
 * The limiter uses the shared client. The operation itself is bounded by the
 * caller's request lifecycle; BullMQ still requires that shared connection to
 * keep its no-retry command setting.
 */
function getRedisForRateLimiter(): Redis {
  return getRedis();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Rate-limit Redis command timed out.")), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { CONSUME_SCRIPT };
