import { describe, expect, it } from "vitest";

import type { RefState } from "@rivet/core";
import { GitHubPermissionDeniedError } from "@rivet/core";

import { FakeGitHubClient } from "./fake-github";

const REPO = { owner: "acme", name: "widgets" };
const REF = "heads/rivet/job-1234-fix-widget";
const REF_STATE: RefState = { commitSha: "commit-sha", treeSha: "tree-sha" };

describe("FakeGitHubClient", () => {
  it("returns scripted values and records calls in order", async () => {
    const github = new FakeGitHubClient({
      repositories: [
        { id: 100, owner: "acme", name: "widgets", private: false, defaultBranch: "main" },
      ],
      refs: { [`acme/widgets#${REF}`]: REF_STATE },
    });

    await expect(github.listRepositories(42)).resolves.toHaveLength(1);
    await expect(github.getRef(42, REPO, REF)).resolves.toEqual(REF_STATE);
    await expect(github.findPullRequest(42, REPO, "missing")).resolves.toBeNull();
    const token = await github.mintInstallationToken(42, REPO, "write");

    expect(token.redact()).toBe("[REDACTED]");
    expect(github.calls.map((call) => call.method)).toEqual([
      "listRepositories",
      "getRef",
      "findPullRequest",
      "mintInstallationToken",
    ]);
    expect(github.calls[3]).toMatchObject({ installationId: 42, repo: REPO, scope: "write" });
  });

  it("can fail one named call with a provider response", async () => {
    const github = new FakeGitHubClient();
    github.failNext("getRef", { status: 404, message: "App cannot see this repository" });

    await expect(github.getRef(42, REPO, REF)).rejects.toBeInstanceOf(GitHubPermissionDeniedError);
    await expect(github.getRef(42, REPO, REF)).resolves.toBeNull();
    expect(github.calls).toHaveLength(2);
  });

  it("creates pull requests and lets tests seed an existing one", async () => {
    const github = new FakeGitHubClient({
      pullRequests: [
        {
          nodeId: "existing-node",
          number: 7,
          url: "https://github.com/acme/widgets/pull/7",
          branch: "rivet/job-existing",
          state: "closed",
        },
      ],
    });
    github.setPullRequest({
      nodeId: "merged-node",
      number: 8,
      url: "https://github.com/acme/widgets/pull/8",
      branch: "rivet/job-merged",
      state: "merged",
    });

    await expect(github.findPullRequest(42, REPO, "rivet/job-existing")).resolves.toMatchObject({
      number: 7,
      state: "closed",
    });
    await expect(github.findPullRequest(42, REPO, "rivet/job-merged")).resolves.toMatchObject({
      number: 8,
      state: "merged",
    });
    await expect(
      github.createPullRequest({
        installationId: 42,
        repo: REPO,
        head: "rivet/job-new",
        base: "main",
        title: "Fix",
        body: "body",
      }),
    ).resolves.toMatchObject({ number: 9, state: "open" });

    expect(github.calls.map((call) => call.method)).toEqual([
      "findPullRequest",
      "findPullRequest",
      "createPullRequest",
    ]);
  });
});
