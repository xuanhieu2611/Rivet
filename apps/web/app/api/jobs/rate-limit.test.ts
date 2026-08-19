import type * as RivetCore from "@rivet/core";
import { ActiveJobLimitError } from "@rivet/core";
import type * as RivetQueue from "@rivet/queue";
import { RateLimitUnavailableError, type RateLimitResult } from "@rivet/queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const consume = vi.fn<(key: string, limit: number, windowMs: number) => Promise<RateLimitResult>>();
const createJob = vi.fn();
const requestJobRun = vi.fn();

vi.mock("@rivet/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof RivetQueue>();
  return { ...actual, getRateLimiter: () => ({ consume }), getJobQueue: () => ({}) };
});

vi.mock("@rivet/core", async (importOriginal) => {
  const actual = await importOriginal<typeof RivetCore>();
  return {
    ...actual,
    createJob: (...args: unknown[]) => createJob(...args) as unknown,
    requestJobRun: (...args: unknown[]) => requestJobRun(...args) as unknown,
  };
});

const { POST } = await import("./route");

/**
 * **Acceptance run F, the live half.**
 *
 * `docs/plans/milestone-11.md`: "Creation attempts past the window limit return
 * 429 with a reset hint and leave **no** `jobs` row. With the active-job cap
 * reached, creation is refused for the same reason. With Redis unreachable,
 * creation is refused rather than allowed."
 *
 * `packages/queue/src/rate-limiter.test.ts` proves the limiter itself fails
 * closed. What it cannot prove is that the *route* honours the refusal, and
 * that is the half that matters: a limiter that returns "denied" into a handler
 * which creates the row anyway has refused nothing. So each case here asserts
 * the status **and** that `createJob` was never called, which is what "leaves
 * no `jobs` row" means one layer down from the database.
 */

const BODY = {
  title: "Add a health check",
  description: "Return 200 at /api/health so uptime checks have something to hit.",
  repoUrl: "https://github.com/rivet/example",
  baseBranch: "main",
  reviewMode: "independent",
  maxReviewLoops: 2,
};

function post(): Request {
  return new Request("http://localhost/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(BODY),
  });
}

beforeEach(() => {
  vi.stubEnv("RIVET_AUTH", "off");
  vi.stubEnv("NODE_ENV", "test");
  consume.mockReset();
  createJob.mockReset();
  requestJobRun.mockReset();
  requestJobRun.mockResolvedValue({ result: "enqueued", error: null });
});

afterEach(() => vi.unstubAllEnvs());

describe("acceptance run F - limits refuse, and refuse closed", () => {
  it("creates a job when the window has room, which is the positive control", async () => {
    consume.mockResolvedValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60_000 });
    createJob.mockResolvedValue({ id: "job-1", dispatchGeneration: 1 });

    const response = await POST(post());

    // Without this, every refusal below is satisfiable by a handler that
    // refuses everything, which would prove nothing about the limits.
    expect(response.status).toBe(201);
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it("returns 429 with a reset hint past the window limit, and writes no job", async () => {
    const resetAt = Date.now() + 30_000;
    consume.mockResolvedValue({ allowed: false, remaining: 0, resetAt });
    createJob.mockResolvedValue({ id: "job-1", dispatchGeneration: 1 });

    const response = await POST(post());
    const body = (await response.json()) as { resetAt: string; retryAfterSeconds: number };

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(body.retryAfterSeconds));
    expect(new Date(body.resetAt).getTime()).toBe(resetAt);
    expect(createJob).not.toHaveBeenCalled();
  });

  it("refuses closed when Redis cannot answer, and writes no job", async () => {
    consume.mockRejectedValue(new RateLimitUnavailableError({ cause: new Error("redis is down") }));
    createJob.mockResolvedValue({ id: "job-1", dispatchGeneration: 1 });

    const response = await POST(post());
    const body = (await response.json()) as { error: string };

    // 503 rather than 429: the limit was not exceeded, it could not be
    // evaluated. What matters for this run is which way the handler fell.
    expect(response.status).toBe(503);
    expect(body.error).toContain("refused closed");
    expect(createJob).not.toHaveBeenCalled();
  });

  it("refuses at the active-job cap and never enqueues", async () => {
    consume.mockResolvedValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60_000 });
    createJob.mockRejectedValue(new ActiveJobLimitError(3, 3));

    const response = await POST(post());
    const body = (await response.json()) as { limit: string; limitValue: number };

    expect(response.status).toBe(429);
    expect(body.limit).toBe("active_jobs");
    expect(body.limitValue).toBe(3);
    // The cap is refused by the writer, so the row was never committed - and
    // nothing must reach the queue either, or the sweeper would find a message
    // for a job that does not exist.
    expect(requestJobRun).not.toHaveBeenCalled();
  });
});
