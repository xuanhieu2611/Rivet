import type { JobArtifact, JobDetail } from "@rivet/contracts";
import { getArtifact, getJob } from "@rivet/core";
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
  return { ...actual, getArtifact: vi.fn(), getJob: vi.fn() };
});

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
  attemptCount: 1,
  failureCategory: null,
  cancelRequestedAt: null,
  leaseExpiresAt: null,
  reviewMode: "independent",
  maxReviewLoops: 2,
  reviewLoops: 0,
  reviewDecision: null,
  reviewBlockingCount: null,
};

const ARTIFACT: JobArtifact = {
  id: 18,
  jobId: JOB_ID,
  type: "diff",
  phase: "testing",
  content: "@@ -1 +1 @@\n-old\n+new\n",
  byteSize: 29,
  truncated: false,
  metadata: { filesChanged: 1 },
  createdAt: new Date("2026-01-01T00:01:00.000Z"),
};

function context(artifactId = "18") {
  return { params: Promise.resolve({ id: JOB_ID, artifactId }) };
}

beforeEach(() => {
  vi.mocked(getJob).mockReset();
  vi.mocked(getArtifact).mockReset();
  vi.mocked(getJob).mockResolvedValue(JOB);
  vi.mocked(getArtifact).mockResolvedValue(ARTIFACT);
});

describe("GET /api/jobs/:id/artifacts/:artifactId", () => {
  it("returns the serialized artifact content", async () => {
    const response = await GET(
      new Request(`http://localhost/api/jobs/${JOB_ID}/artifacts/${String(ARTIFACT.id)}`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...ARTIFACT,
      createdAt: ARTIFACT.createdAt.toISOString(),
    });
    expect(getArtifact).toHaveBeenCalledWith(JOB_ID, ARTIFACT.id);
  });

  it("rejects an invalid artifact id", async () => {
    const response = await GET(
      new Request(`http://localhost/api/jobs/${JOB_ID}/artifacts/nope`),
      context("nope"),
    );

    expect(response.status).toBe(400);
    expect(getJob).not.toHaveBeenCalled();
  });

  it("returns 404 when the artifact is not part of the job", async () => {
    vi.mocked(getArtifact).mockResolvedValue(null);

    const response = await GET(
      new Request(`http://localhost/api/jobs/${JOB_ID}/artifacts/19`),
      context("19"),
    );

    expect(response.status).toBe(404);
  });
});
