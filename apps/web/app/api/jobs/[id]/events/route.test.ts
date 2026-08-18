import type { JobDetail, JobEvent } from "@rivet/contracts";
import { getJob, listEvents } from "@rivet/core";
import type * as RivetCore from "@rivet/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

vi.mock("server-only", () => ({}));
// Spread over the real module rather than replaced outright: the route is
// wrapped in `withRoute`, which reads the telemetry attribute names and the
// no-op port from here, and a mock that lists only the queries under test
// would make every handler fail on an import rather than on its behaviour.
vi.mock("@rivet/core", async (importOriginal) => {
  const actual = await importOriginal<typeof RivetCore>();
  return { ...actual, getJob: vi.fn(), listEvents: vi.fn() };
});

const JOB_ID = "11111111-2222-3333-4444-555555555555";
const JOB: JobDetail = {
  id: JOB_ID,
  title: "Streaming job",
  description: "Test job",
  repoUrl: "https://github.com/rivet/example",
  baseBranch: "main",
  status: "queued",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  baseCommitSha: null,
  traceContext: null,
  githubInstallationId: null,
  repoOwner: null,
  repoName: null,
  issueNumber: null,
  issueUrl: null,
  envFingerprint: null,
  priority: 0,
  maxDurationSeconds: 3_600,
  maxCostUsd: "5.00",
  maxModelCalls: 200,
  maxToolCalls: 500,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: "0.0000",
  totalTurns: 0,
  totalModelCalls: 0,
  totalToolCalls: 0,
  deadlineAt: null,
  dispatchGeneration: 0,
  startedAt: null,
  completedAt: null,
  finalBranch: null,
  pullRequestUrl: null,
  pullRequestNumber: null,
  failureReason: null,
  attemptCount: 0,
  failureCategory: null,
  cancelRequestedAt: null,
  leaseExpiresAt: null,
  reviewMode: "independent",
  maxReviewLoops: 2,
  reviewLoops: 0,
  reviewDecision: null,
  reviewBlockingCount: null,
};

const EVENT: JobEvent = {
  id: 12,
  jobId: JOB_ID,
  type: "job.created",
  message: "Job created",
  data: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function context() {
  return { params: Promise.resolve({ id: JOB_ID }) };
}

beforeEach(() => {
  vi.mocked(getJob).mockReset();
  vi.mocked(listEvents).mockReset();
  vi.mocked(getJob).mockResolvedValue(JOB);
  vi.mocked(listEvents).mockResolvedValue([EVENT]);
});

describe("GET /api/jobs/:id/events", () => {
  it("keeps the JSON cursor envelope for ordinary requests", async () => {
    const response = await GET(
      new Request(`http://localhost/api/jobs/${JOB_ID}/events`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ events: [{ id: EVENT.id }], cursor: EVENT.id });
    expect(listEvents).toHaveBeenCalledWith(JOB_ID, {});
  });

  it("uses the newer Last-Event-ID cursor when JSON callers provide both", async () => {
    const request = new Request(`http://localhost/api/jobs/${JOB_ID}/events?after=10`, {
      headers: { "Last-Event-ID": "12" },
    });

    await GET(request, context());

    expect(listEvents).toHaveBeenCalledWith(JOB_ID, { after: 12 });
  });

  it("opens an SSE response when text/event-stream is accepted", async () => {
    const abort = new AbortController();
    vi.mocked(listEvents).mockResolvedValue([]);
    const response = await GET(
      new Request(`http://localhost/api/jobs/${JOB_ID}/events`, {
        headers: { Accept: "application/json, text/event-stream; q=1" },
        signal: abort.signal,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.read();
    abort.abort();
    await reader?.cancel();
  });

  it("rejects an invalid cursor before touching the database", async () => {
    const response = await GET(
      new Request(`http://localhost/api/jobs/${JOB_ID}/events?after=1.5`),
      context(),
    );

    expect(response.status).toBe(400);
    expect(getJob).not.toHaveBeenCalled();
  });

  it("returns 404 before committing SSE headers for an unknown job", async () => {
    vi.mocked(getJob).mockResolvedValue(null);

    const response = await GET(
      new Request(`http://localhost/api/jobs/${JOB_ID}/events`, {
        headers: { Accept: "text/event-stream" },
      }),
      context(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
