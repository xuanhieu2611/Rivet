import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Job } from "@rivet/database";
import { afterEach, describe, expect, it } from "vitest";

import { toJobDetail } from "../jobs/job-service";
import type { Redactor } from "../telemetry/redaction";
import {
  artifactDigests,
  commandDigests,
  isStatusTransition,
  jobToReplayDocument,
  loadReplayFixture,
  pacedDelayMs,
  projectedEventTypes,
  replayNameSchema,
  writeReplayFixture,
  type ReplaySource,
} from "./fixture";

const IDENTITY: Redactor = {
  redact: (value) => value,
  redactDeep: (value) => value,
};

const row: Job = {
  traceContext: null,
  id: "6f1c9c3e-6a5b-4a6f-9a0f-2b3c4d5e6f70",
  title: "Fix the booking race",
  description: "Two concurrent POSTs must not double-book the slot.",
  repoUrl: "https://github.com/acme/widgets",
  baseBranch: "main",
  baseCommitSha: "a".repeat(40),
  githubInstallationId: 4242,
  repoOwner: "acme",
  repoName: "widgets",
  issueNumber: 7,
  issueUrl: "https://github.com/acme/widgets/issues/7",
  status: "completed",
  priority: 0,
  maxDurationSeconds: 3600,
  maxCostUsd: "5.00",
  maxModelCalls: 200,
  maxToolCalls: 500,
  totalInputTokens: 120,
  totalOutputTokens: 80,
  totalCostUsd: "1.2500",
  totalModelCalls: 4,
  totalToolCalls: 9,
  totalTurns: 3,
  dispatchGeneration: 0,
  deadlineAt: new Date("2026-01-01T00:10:00.000Z"),
  startedAt: new Date("2026-01-01T00:00:01.000Z"),
  completedAt: new Date("2026-01-01T00:03:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:03:00.000Z"),
  finalBranch: "rivet/booking-fix",
  pullRequestUrl: "https://github.com/acme/widgets/pull/99",
  pullRequestNumber: 99,
  failureReason: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  attemptCount: 1,
  cancelRequestedAt: null,
  failureCategory: null,
  sandboxId: "sandbox-1",
  envFingerprint: { node: "24.0.0" },
  reviewMode: "independent",
  maxReviewLoops: 2,
  reviewLoops: 0,
  reviewDecision: "approve",
  reviewBlockingCount: 0,
};

function source(directoryName = "booking-roundtrip"): ReplaySource {
  return {
    name: directoryName,
    sourceJobId: row.id,
    capturedAt: new Date("2026-08-19T12:00:00.000Z"),
    created: {
      title: row.title,
      description: row.description,
      repoUrl: row.repoUrl,
      baseBranch: row.baseBranch,
      reviewMode: "independent",
      maxReviewLoops: 2,
      maxDurationSeconds: 3600,
      maxCostUsd: "5.00",
      maxModelCalls: 200,
      maxToolCalls: 500,
      githubInstallationId: 4242,
      repoOwner: "acme",
      repoName: "widgets",
      issueNumber: 7,
      issueUrl: "https://github.com/acme/widgets/issues/7",
    },
    facts: {
      status: "completed",
      baseCommitSha: row.baseCommitSha,
      envFingerprint: { node: "24.0.0" },
      finalBranch: "rivet/booking-fix",
      pullRequestUrl: "https://github.com/acme/widgets/pull/99",
      pullRequestNumber: 99,
      failureReason: null,
      failureCategory: null,
      reviewDecision: "approve",
      reviewLoops: 0,
      reviewBlockingCount: 0,
      totalInputTokens: 120,
      totalOutputTokens: 80,
      totalCostUsd: "1.2500",
      totalTurns: 3,
      totalModelCalls: 4,
      totalToolCalls: 9,
    },
    events: [
      {
        offsetMs: 0,
        type: "job.created",
        message: "Job created: Fix the booking race",
        data: null,
      },
      {
        offsetMs: 10,
        type: "job.claimed",
        message: "Claimed.",
        data: { from: "queued", to: "provisioning" },
      },
      {
        offsetMs: 20,
        type: "phase.started",
        message: "Provision sandbox",
        data: { phase: "Provision sandbox" },
      },
    ],
    artifacts: [
      {
        id: 7,
        type: "diff",
        phase: "testing",
        content: "diff --git a/a.ts b/a.ts\n",
        byteSize: 26,
        truncated: false,
        metadata: null,
      },
    ],
    commands: [
      {
        id: 3,
        phase: "provisioning",
        argv: ["git", "rev-parse", "HEAD"],
        cwd: "/home/node/workspace",
        exitCode: 0,
        durationMs: 12,
        stdout: `${"a".repeat(40)}\n`,
        stderr: "",
        truncated: false,
        timedOut: false,
        oomKilled: false,
      },
    ],
  };
}

describe("replayNameSchema", () => {
  it("accepts lowercase kebab-case", () => {
    expect(replayNameSchema.parse("booking")).toBe("booking");
    expect(replayNameSchema.parse("booking-race")).toBe("booking-race");
  });

  it("rejects titles, paths and uppercase", () => {
    expect(() => replayNameSchema.parse("Booking")).toThrow();
    expect(() => replayNameSchema.parse("booking_race")).toThrow();
    expect(() => replayNameSchema.parse("../booking")).toThrow();
    expect(() => replayNameSchema.parse("booking/race")).toThrow();
    expect(() => replayNameSchema.parse("")).toThrow();
  });
});

describe("pacedDelayMs", () => {
  it("plays recorded time at speed 1, compresses below it, and skips at 0", () => {
    expect(pacedDelayMs(0, 1_000, 1)).toBe(1_000);
    expect(pacedDelayMs(0, 1_000, 0.3)).toBe(300);
    expect(pacedDelayMs(0, 1_000, 0)).toBe(0);
    expect(pacedDelayMs(50, 40, 1)).toBe(0);
  });
});

describe("isStatusTransition", () => {
  it("is true only when from and to are different job statuses", () => {
    expect(isStatusTransition({ data: { from: "queued", to: "provisioning" } })).toBe(true);
    expect(isStatusTransition({ data: { from: "provisioning", to: "provisioning" } })).toBe(false);
    expect(isStatusTransition({ data: { phase: "Provision sandbox" } })).toBe(false);
    expect(isStatusTransition({ data: null })).toBe(false);
  });
});

describe("jobToReplayDocument", () => {
  it("copies creation input and terminal facts from a finished job", () => {
    const document = jobToReplayDocument(
      toJobDetail(row),
      "booking",
      row.completedAt ?? new Date(),
    );

    expect(document.created.githubInstallationId).toBe(4242);
    expect(document.created.issueUrl).toBe("https://github.com/acme/widgets/issues/7");
    expect(document.facts.status).toBe("completed");
    expect(document.facts.pullRequestNumber).toBe(99);
    expect(document.facts.reviewDecision).toBe("approve");
    expect(document.facts.totalCostUsd).toBe("1.2500");
  });

  it("refuses a job that is still in flight", () => {
    expect(() =>
      jobToReplayDocument(toJobDetail({ ...row, status: "implementing" }), "booking"),
    ).toThrow(/only a terminal job can be captured/);
  });
});

describe("writeReplayFixture / loadReplayFixture", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("round-trips a fixture through staging so a load sees the same bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rivet-replay-"));
    directories.push(directory);
    const fixtureDir = join(directory, "booking-roundtrip");
    const original = source();

    await writeReplayFixture({ directory: fixtureDir, source: original, redactor: IDENTITY });
    const loaded = await loadReplayFixture(fixtureDir);

    expect(loaded.name).toBe("booking-roundtrip");
    expect(loaded.sourceJobId).toBe(original.sourceJobId);
    expect(loaded.created).toEqual(original.created);
    expect(loaded.facts).toEqual(original.facts);
    expect(loaded.events).toEqual(original.events);
    expect(loaded.artifacts).toEqual(original.artifacts);
    expect(loaded.commands).toEqual(original.commands);
    expect(projectedEventTypes(loaded.events)).toEqual([
      "job.created",
      "job.claimed",
      "phase.started",
    ]);
    expect(artifactDigests(loaded.artifacts)).toEqual(artifactDigests(original.artifacts));
    expect(commandDigests(loaded.commands)).toEqual(commandDigests(original.commands));
  });
});
