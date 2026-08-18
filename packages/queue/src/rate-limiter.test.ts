import { describe, expect, it, vi } from "vitest";

import { RateLimitUnavailableError, RedisRateLimiter } from "./rate-limiter";

describe("RedisRateLimiter", () => {
  it("returns the atomic script's decision and reset time", async () => {
    const redis = { eval: vi.fn().mockResolvedValue([1, 1_700_000_600_000, 4]) };
    const limiter = new RedisRateLimiter(redis);

    await expect(limiter.consume("rivet:test", 5, 600_000)).resolves.toEqual({
      allowed: true,
      resetAt: 1_700_000_600_000,
      remaining: 4,
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("TIME")'),
      1,
      "rivet:test",
      "5",
      "600000",
    );
  });

  it("reports a denied window without throwing", async () => {
    const limiter = new RedisRateLimiter({
      eval: vi.fn().mockResolvedValue([0, 1_700_000_600_000, 0]),
    });

    await expect(limiter.consume("rivet:test", 5, 600_000)).resolves.toEqual({
      allowed: false,
      resetAt: 1_700_000_600_000,
      remaining: 0,
    });
  });

  it("fails closed when Redis cannot answer", async () => {
    const limiter = new RedisRateLimiter({ eval: vi.fn().mockRejectedValue(new Error("offline")) });

    await expect(limiter.consume("rivet:test", 5, 600_000)).rejects.toBeInstanceOf(
      RateLimitUnavailableError,
    );
  });

  it("rejects malformed Redis responses", async () => {
    const limiter = new RedisRateLimiter({ eval: vi.fn().mockResolvedValue([1, "later"]) });

    await expect(limiter.consume("rivet:test", 5, 600_000)).rejects.toBeInstanceOf(
      RateLimitUnavailableError,
    );
  });
});
