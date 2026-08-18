import { describe, expect, it } from "vitest";

import { DEFAULT_WEB_RATE_LIMIT_CONFIG, resolveWebRateLimitConfig } from "./config";

describe("resolveWebRateLimitConfig", () => {
  it("uses the Stage 10 defaults", () => {
    expect(resolveWebRateLimitConfig({})).toEqual(DEFAULT_WEB_RATE_LIMIT_CONFIG);
  });

  it("keeps each limit independently configurable", () => {
    expect(
      resolveWebRateLimitConfig({
        RIVET_JOB_CREATION_LIMIT: "8",
        RIVET_JOB_CREATION_WINDOW_MS: "120000",
        RIVET_UNAUTHENTICATED_RATE_LIMIT: "12",
        RIVET_UNAUTHENTICATED_RATE_LIMIT_WINDOW_MS: "300000",
        RIVET_ACTIVE_JOB_CAP: "6",
      }),
    ).toEqual({
      jobCreationLimit: 8,
      jobCreationWindowMs: 120_000,
      unauthenticatedLimit: 12,
      unauthenticatedWindowMs: 300_000,
      activeJobCap: 6,
    });
  });

  it("rejects invalid values instead of silently disabling protection", () => {
    expect(() => resolveWebRateLimitConfig({ RIVET_ACTIVE_JOB_CAP: "0" })).toThrow(
      "RIVET_ACTIVE_JOB_CAP",
    );
    expect(() => resolveWebRateLimitConfig({ RIVET_JOB_CREATION_WINDOW_MS: "999" })).toThrow(
      "1000 milliseconds",
    );
  });
});
