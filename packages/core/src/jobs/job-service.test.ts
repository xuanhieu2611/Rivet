import type { Job } from "@rivet/database";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_JOB_LIST_LIMIT,
  isJobId,
  MAX_JOB_LIST_LIMIT,
  resolveListLimit,
  toJobDetail,
  toJobSummary,
} from "./job-service";

/**
 * These cover the pure half of the service: the parts that decide what reaches
 * Postgres and what shape comes back. The query-building half needs a real
 * database and is out of scope for Milestone 0 - `@rivet/database` builds its
 * client lazily, so importing this module opens no connection.
 */

const row: Job = {
  id: "6f1c9c3e-6a5b-4a6f-9a0f-2b3c4d5e6f70",
  title: "Add a health check endpoint",
  description: "Return 200 with the build SHA at /api/health.",
  repoUrl: "https://github.com/acme/widgets",
  baseBranch: "main",
  baseCommitSha: null,
  githubInstallationId: null,
  repoOwner: null,
  repoName: null,
  issueNumber: null,
  issueUrl: null,
  status: "queued",
  priority: 0,
  maxDurationSeconds: 3600,
  maxCostUsd: "5.00",
  maxModelCalls: 200,
  maxToolCalls: 500,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: "0.0000",
  totalModelCalls: 0,
  totalToolCalls: 0,
  totalTurns: 0,
  dispatchGeneration: 0,
  deadlineAt: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  finalBranch: null,
  pullRequestUrl: null,
  pullRequestNumber: null,
  failureReason: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  attemptCount: 0,
  cancelRequestedAt: null,
  failureCategory: null,
  sandboxId: null,
  envFingerprint: null,
  reviewMode: "independent",
  maxReviewLoops: 2,
  reviewLoops: 0,
  reviewDecision: null,
  reviewBlockingCount: null,
};

describe("isJobId", () => {
  it("accepts a uuid", () => {
    expect(isJobId(row.id)).toBe(true);
    expect(isJobId(row.id.toUpperCase())).toBe(true);
  });

  it("rejects anything Postgres would choke on", () => {
    for (const value of ["", "abc", "123", "6f1c9c3e6a5b4a6f9a0f2b3c4d5e6f70", "'; drop table"]) {
      expect(isJobId(value)).toBe(false);
    }
  });
});

describe("resolveListLimit", () => {
  it("defaults when nothing usable is supplied", () => {
    expect(resolveListLimit(null)).toBe(DEFAULT_JOB_LIST_LIMIT);
    expect(resolveListLimit(undefined)).toBe(DEFAULT_JOB_LIST_LIMIT);
    expect(resolveListLimit("")).toBe(DEFAULT_JOB_LIST_LIMIT);
    expect(resolveListLimit("not a number")).toBe(DEFAULT_JOB_LIST_LIMIT);
  });

  it("caps the limit so a caller cannot ask for the whole table", () => {
    expect(resolveListLimit("100000")).toBe(MAX_JOB_LIST_LIMIT);
    expect(resolveListLimit(Number.MAX_SAFE_INTEGER)).toBe(MAX_JOB_LIST_LIMIT);
  });

  it("floors to at least one row", () => {
    expect(resolveListLimit("0")).toBe(1);
    expect(resolveListLimit("-25")).toBe(1);
  });

  it("passes sane values through, truncating fractions", () => {
    expect(resolveListLimit("10")).toBe(10);
    expect(resolveListLimit("10.9")).toBe(10);
  });
});

describe("row mapping", () => {
  it("keeps the summary to the columns the dashboard renders", () => {
    expect(toJobSummary(row)).toEqual({
      id: row.id,
      title: row.title,
      repoUrl: row.repoUrl,
      baseBranch: row.baseBranch,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });

  it("does not leak the description into list rows", () => {
    expect(toJobSummary(row)).not.toHaveProperty("description");
  });

  it("carries budgets and nullable execution columns onto the detail payload", () => {
    const detail = toJobDetail(row);
    expect(detail.maxCostUsd).toBe("5.00");
    expect(detail.maxDurationSeconds).toBe(3600);
    expect(detail.totalInputTokens).toBe(0);
    expect(detail.totalOutputTokens).toBe(0);
    expect(detail.totalCostUsd).toBe("0.0000");
    expect(detail.startedAt).toBeNull();
    expect(detail.pullRequestUrl).toBeNull();
    expect(detail.createdAt).toBeInstanceOf(Date);
    expect(detail.attemptCount).toBe(0);
    expect(detail.failureCategory).toBeNull();
    expect(detail.envFingerprint).toBeNull();
    expect(detail.leaseExpiresAt).toBeNull();
  });

  it("keeps the lease columns off the summary", () => {
    // `JobSummary` stays narrow: the dashboard renders hundreds of these.
    const summary = toJobSummary(row);
    expect(summary).not.toHaveProperty("attemptCount");
    expect(summary).not.toHaveProperty("leaseExpiresAt");
  });

  it("degrades an unrecognised failure category rather than dropping it", () => {
    // A newer build could write a category this one does not know. "we do not
    // recognise this failure" and "this did not fail" must not look alike.
    expect(toJobDetail({ ...row, failureCategory: "repo_unavailable" }).failureCategory).toBe(
      "repo_unavailable",
    );
    expect(toJobDetail({ ...row, failureCategory: "from_the_future" }).failureCategory).toBe(
      "unknown",
    );
  });

  it("carries the review columns onto the detail payload", () => {
    const detail = toJobDetail(row);
    expect(detail.reviewMode).toBe("independent");
    expect(detail.maxReviewLoops).toBe(2);
    expect(detail.reviewLoops).toBe(0);
    expect(detail.reviewDecision).toBeNull();
    expect(detail.reviewBlockingCount).toBeNull();
  });

  it("coerces review columns a newer build could have written", () => {
    // Both are plain text columns, so neither value is guaranteed to be in this
    // build's vocabulary. An unreadable mode still means the job is reviewed;
    // an unreadable verdict is not allowed to masquerade as an approval.
    expect(toJobDetail({ ...row, reviewMode: "none" }).reviewMode).toBe("none");
    expect(toJobDetail({ ...row, reviewMode: "committee" }).reviewMode).toBe("independent");
    expect(toJobDetail({ ...row, reviewDecision: "revise" }).reviewDecision).toBe("revise");
    expect(toJobDetail({ ...row, reviewDecision: "shipit" }).reviewDecision).toBeNull();
  });
});
