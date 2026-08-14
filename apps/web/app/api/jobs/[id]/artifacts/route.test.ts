import type { JobArtifactSummary, JobDetail } from "@rivet/contracts";
import { getJob, listArtifacts } from "@rivet/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@rivet/core", () => ({ getJob: vi.fn(), listArtifacts: vi.fn() }));

const JOB_ID = "11111111-2222-3333-4444-555555555555";
const JOB: JobDetail = {
  id: JOB_ID,
  title: "Artifact job",
  description: "Test job",
  repoUrl: "https://github.com/rivet/example",
  baseBranch: "main",
  status: "completed",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  baseCommitSha: null,
  envFingerprint: null,
  priority: 0,
  maxDurationSeconds: 3_600,
  maxCostUsd: "5.00",
  maxModelCalls: 200,
  maxToolCalls: 500,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: "0.0000",
  dispatchGeneration: 0,
  startedAt: null,
  completedAt: null,
  finalBranch: null,
  pullRequestUrl: null,
  failureReason: null,
  attemptCount: 1,
  failureCategory: null,
  cancelRequestedAt: null,
  leaseExpiresAt: null,
};

const ARTIFACT: JobArtifactSummary = {
  id: 18,
  jobId: JOB_ID,
  type: "diff",
  phase: "testing",
  byteSize: 42,
  truncated: false,
  metadata: { filesChanged: 1 },
  createdAt: new Date("2026-01-01T00:01:00.000Z"),
};

function context() {
  return { params: Promise.resolve({ id: JOB_ID }) };
}

beforeEach(() => {
  vi.mocked(getJob).mockReset();
  vi.mocked(listArtifacts).mockReset();
  vi.mocked(getJob).mockResolvedValue(JOB);
  vi.mocked(listArtifacts).mockResolvedValue([ARTIFACT]);
});

describe("GET /api/jobs/:id/artifacts", () => {
  it("returns serialized artifact metadata with a cursor", async () => {
    const response = await GET(
      new Request(`http://localhost/api/jobs/${JOB_ID}/artifacts`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      artifacts: [{ ...ARTIFACT, createdAt: ARTIFACT.createdAt.toISOString() }],
      cursor: ARTIFACT.id,
    });
    expect(listArtifacts).toHaveBeenCalledWith(JOB_ID, {});
  });

  it("passes a cursor to the artifact store", async () => {
    await GET(new Request(`http://localhost/api/jobs/${JOB_ID}/artifacts?after=17`), context());

    expect(listArtifacts).toHaveBeenCalledWith(JOB_ID, { after: 17 });
  });

  it("rejects an invalid cursor before touching the database", async () => {
    const response = await GET(
      new Request(`http://localhost/api/jobs/${JOB_ID}/artifacts?after=1.5`),
      context(),
    );

    expect(response.status).toBe(400);
    expect(getJob).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown job", async () => {
    vi.mocked(getJob).mockResolvedValue(null);

    const response = await GET(
      new Request(`http://localhost/api/jobs/${JOB_ID}/artifacts`),
      context(),
    );

    expect(response.status).toBe(404);
    expect(listArtifacts).not.toHaveBeenCalled();
  });
});
