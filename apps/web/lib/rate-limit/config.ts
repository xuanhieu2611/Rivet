/** Web rate-limit policy. Values are deployment configuration, not route literals. */
export interface WebRateLimitConfig {
  jobCreationLimit: number;
  jobCreationWindowMs: number;
  unauthenticatedLimit: number;
  unauthenticatedWindowMs: number;
  activeJobCap: number;
}

export const DEFAULT_WEB_RATE_LIMIT_CONFIG: WebRateLimitConfig = {
  jobCreationLimit: 5,
  jobCreationWindowMs: 10 * 60 * 1_000,
  unauthenticatedLimit: 10,
  unauthenticatedWindowMs: 10 * 60 * 1_000,
  activeJobCap: 4,
};

export type WebRateLimitEnv = Partial<Record<string, string>>;

/**
 * Reads the control-plane limits without opening Redis. This remains a pure
 * function so builds and unit tests do not need the runtime configuration.
 */
export function resolveWebRateLimitConfig(env: WebRateLimitEnv = process.env): WebRateLimitConfig {
  return {
    jobCreationLimit: positiveInteger(
      env.RIVET_JOB_CREATION_LIMIT,
      DEFAULT_WEB_RATE_LIMIT_CONFIG.jobCreationLimit,
      "RIVET_JOB_CREATION_LIMIT",
    ),
    jobCreationWindowMs: windowMs(
      env.RIVET_JOB_CREATION_WINDOW_MS,
      DEFAULT_WEB_RATE_LIMIT_CONFIG.jobCreationWindowMs,
      "RIVET_JOB_CREATION_WINDOW_MS",
    ),
    unauthenticatedLimit: positiveInteger(
      env.RIVET_UNAUTHENTICATED_RATE_LIMIT,
      DEFAULT_WEB_RATE_LIMIT_CONFIG.unauthenticatedLimit,
      "RIVET_UNAUTHENTICATED_RATE_LIMIT",
    ),
    unauthenticatedWindowMs: windowMs(
      env.RIVET_UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS,
      DEFAULT_WEB_RATE_LIMIT_CONFIG.unauthenticatedWindowMs,
      "RIVET_UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS",
    ),
    activeJobCap: positiveInteger(
      env.RIVET_ACTIVE_JOB_CAP,
      DEFAULT_WEB_RATE_LIMIT_CONFIG.activeJobCap,
      "RIVET_ACTIVE_JOB_CAP",
    ),
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function windowMs(value: string | undefined, fallback: number, name: string): number {
  const parsed = positiveInteger(value, fallback, name);
  if (parsed < 1_000) throw new Error(`${name} must be at least 1000 milliseconds.`);
  return parsed;
}
