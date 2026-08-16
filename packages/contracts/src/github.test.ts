import { describe, expect, it } from "vitest";

import {
  externalEffectKindSchema,
  externalEffectProviderSchema,
  publicationSkipReasonSchema,
  pullRequestStateSchema,
  type ExternalEffect,
  type Installation,
  type Issue,
  type PullRequest,
  type RepoRef,
  type Repository,
} from "./github";

describe("GitHub value contracts", () => {
  it("exposes the states used by publication and reconciliation", () => {
    expect(pullRequestStateSchema.parse("open")).toBe("open");
    expect(pullRequestStateSchema.parse("merged")).toBe("merged");
    expect(externalEffectKindSchema.parse("branch_pushed")).toBe("branch_pushed");
    expect(externalEffectProviderSchema.parse("github")).toBe("github");
    expect(publicationSkipReasonSchema.parse("no_installation")).toBe("no_installation");

    expect(pullRequestStateSchema.safeParse("draft").success).toBe(false);
    expect(externalEffectKindSchema.safeParse("branch_created").success).toBe(false);
    expect(publicationSkipReasonSchema.safeParse("not_applicable").success).toBe(false);
  });

  it("keeps the adapter values structural and serializable", () => {
    const repo: RepoRef = { owner: "acme", name: "widgets" };
    const installation: Installation = {
      id: 42,
      accountLogin: "acme",
      accountType: "Organization",
      targetType: "Organization",
      permissions: { contents: "write", pull_requests: "write" },
      suspended: false,
    };
    const repository: Repository = {
      ...repo,
      id: 100,
      private: true,
      defaultBranch: "main",
    };
    const issue: Issue = {
      number: 17,
      title: "Fix the widget",
      body: "The widget fails.",
      htmlUrl: "https://github.com/acme/widgets/issues/17",
      state: "open",
    };
    const pullRequest: PullRequest = {
      nodeId: "PR_kwDO123",
      number: 18,
      url: "https://github.com/acme/widgets/pull/18",
      branch: "rivet/job-1234-fix-widget",
      state: "open",
    };
    const effect: ExternalEffect = {
      id: 1,
      jobId: "11111111-2222-3333-8444-555555555555",
      kind: "branch_pushed",
      provider: "github",
      externalId: "commit-sha",
      externalUrl: "https://github.com/acme/widgets/tree/rivet/job-1234-fix-widget",
      payload: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    expect({ repo, installation, repository, issue, pullRequest, effect }).toBeDefined();
  });
});
