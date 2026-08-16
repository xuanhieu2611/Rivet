import { describe, expect, it } from "vitest";

import type { GitHubOctokit, GitHubOctokitResponse } from "./app";
import { OctokitGitHubClient } from "./github-client";
import appInstallations from "./fixtures/app-installations.json";
import commit from "./fixtures/commit.json";
import installationRepositories from "./fixtures/installation-repositories.json";
import installationToken from "./fixtures/installation-token.json";
import issues from "./fixtures/issues.json";
import pullRequests from "./fixtures/pull-requests.json";
import ref from "./fixtures/ref.json";

const REPO = { owner: "acme", name: "widgets" };
const BRANCH = "rivet/job-1234-fix-widget";

interface RequestFailure {
  route: string;
  status: number;
  message: string;
  headers?: Record<string, string>;
  remaining: number;
}

class FixtureOctokit implements GitHubOctokit {
  readonly requests: { route: string; parameters: Record<string, unknown> | undefined }[] = [];
  readonly pagination: { route: string; parameters: Record<string, unknown> | undefined }[] = [];
  readonly authCalls: Record<string, unknown>[] = [];
  readonly failures: RequestFailure[] = [];

  auth(options: Record<string, unknown>): Promise<{ token: string; expiresAt: string }> {
    this.authCalls.push(options);
    return Promise.resolve({
      token: installationToken.token,
      expiresAt: installationToken.expires_at,
    });
  }

  request<T = unknown>(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<GitHubOctokitResponse<T>> {
    this.requests.push({ route, parameters });
    const failure = this.takeFailure(route);
    if (failure) return Promise.reject(this.errorFor(failure));

    const data = this.responseFor<T>(route);
    return Promise.resolve({ data, status: 200, headers: {} });
  }

  paginate<T = unknown>(route: string, parameters?: Record<string, unknown>): Promise<T[]> {
    this.pagination.push({ route, parameters });
    const failure = this.takeFailure(route);
    if (failure) return Promise.reject(this.errorFor(failure));
    if (route === "GET /app/installations") return Promise.resolve(appInstallations as T[]);
    if (route === "GET /installation/repositories") {
      return Promise.resolve(installationRepositories as T[]);
    }
    if (route === "GET /repos/{owner}/{repo}/issues") return Promise.resolve(issues as T[]);
    if (route === "GET /repos/{owner}/{repo}/pulls") return Promise.resolve(pullRequests as T[]);
    throw new Error(`No fixture for ${route}`);
  }

  private takeFailure(route: string): RequestFailure | undefined {
    const failure = this.failures.find(
      (candidate) => candidate.route === route && candidate.remaining > 0,
    );
    if (failure) failure.remaining -= 1;
    return failure;
  }

  private errorFor(failure: RequestFailure): Error {
    return Object.assign(new Error(failure.message), {
      response: {
        status: failure.status,
        headers: failure.headers ?? {},
        data: { message: failure.message },
      },
    });
  }

  private responseFor<T>(route: string): T {
    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") return ref as T;
    if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") return commit as T;
    if (route === "POST /repos/{owner}/{repo}/pulls") return pullRequests[0] as T;
    if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") return pullRequests[0] as T;
    throw new Error(`No fixture for ${route}`);
  }
}

function fixtureApp(octokit: FixtureOctokit): {
  octokit: FixtureOctokit;
  getInstallationOctokit: (installationId: number) => Promise<FixtureOctokit>;
} {
  return {
    octokit,
    getInstallationOctokit: () => Promise.resolve(octokit),
  };
}

describe("OctokitGitHubClient", () => {
  it("maps recorded GitHub responses into domain values", async () => {
    const octokit = new FixtureOctokit();
    const client = new OctokitGitHubClient({ app: fixtureApp(octokit) });

    await expect(client.listInstallations()).resolves.toEqual([
      {
        id: 42,
        accountLogin: "acme",
        accountType: "Organization",
        targetType: "Organization",
        permissions: {
          contents: "write",
          issues: "read",
          metadata: "read",
          pull_requests: "write",
        },
        suspended: false,
      },
    ]);
    await expect(client.listRepositories(42)).resolves.toEqual([
      { id: 100, owner: "acme", name: "widgets", private: true, defaultBranch: "main" },
    ]);
    await expect(client.listIssues(42, REPO)).resolves.toEqual([
      {
        number: 17,
        title: "Fix the widget",
        body: "The widget fails under concurrent use.",
        htmlUrl: "https://github.com/acme/widgets/issues/17",
        state: "open",
      },
    ]);
    await expect(client.getRef(42, REPO, `refs/heads/${BRANCH}`)).resolves.toEqual({
      commitSha: "commit-sha-1",
      treeSha: "tree-sha-1",
    });
    await expect(client.findPullRequest(42, REPO, BRANCH)).resolves.toEqual({
      nodeId: "PR_kwDO123",
      number: 18,
      url: "https://github.com/acme/widgets/pull/18",
      branch: BRANCH,
      state: "open",
    });

    const token = await client.mintInstallationToken(42, REPO, "read");
    expect(token.value).toBe(installationToken.token);
    expect(token.redact()).toBe("[REDACTED]");
    expect(JSON.stringify(token)).not.toContain(installationToken.token);
    await client.mintInstallationToken(42, REPO, "write");
    expect(octokit.authCalls).toEqual([
      {
        type: "installation",
        installationId: 42,
        repositoryNames: ["widgets"],
        permissions: { contents: "read" },
      },
      {
        type: "installation",
        installationId: 42,
        repositoryNames: ["widgets"],
        permissions: { contents: "write", pull_requests: "write" },
      },
    ]);

    await client.createPullRequest({
      installationId: 42,
      repo: REPO,
      head: BRANCH,
      base: "main",
      title: "Fix the widget",
      body: "body",
    });
    await client.updatePullRequest({
      installationId: 42,
      repo: REPO,
      number: 18,
      body: "updated body",
    });
    expect(octokit.requests.map((request) => request.route)).toEqual([
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      "POST /repos/{owner}/{repo}/pulls",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
  });

  it("retries three transient failures before accepting the fourth response", async () => {
    const octokit = new FixtureOctokit();
    octokit.failures.push({
      route: "GET /repos/{owner}/{repo}/git/ref/{ref}",
      status: 503,
      message: "GitHub is temporarily unavailable",
      remaining: 3,
    });
    const delays: number[] = [];
    const client = new OctokitGitHubClient({
      app: fixtureApp(octokit),
      initialDelayMs: 10,
      maxDelayMs: 100,
      random: () => 1,
      sleep: (delayMs) => {
        delays.push(delayMs);
        return Promise.resolve();
      },
    });

    await expect(client.getRef(42, REPO, `heads/${BRANCH}`)).resolves.toMatchObject({
      treeSha: "tree-sha-1",
    });
    expect(delays).toEqual([10, 20, 40]);
    expect(octokit.requests.filter((request) => request.route.includes("git/ref")).length).toBe(4);
  });

  it("uses Retry-After as a lower bound for rate-limit retries", async () => {
    const octokit = new FixtureOctokit();
    octokit.failures.push({
      route: "GET /app/installations",
      status: 429,
      message: "secondary rate limit",
      headers: { "retry-after": "2" },
      remaining: 1,
    });
    const delays: number[] = [];
    const client = new OctokitGitHubClient({
      app: fixtureApp(octokit),
      initialDelayMs: 10,
      random: () => 0,
      sleep: (delayMs) => {
        delays.push(delayMs);
        return Promise.resolve();
      },
    });

    await expect(client.listInstallations()).resolves.toHaveLength(1);
    expect(delays).toEqual([2_000]);
  });

  it("returns null for a missing remote ref", async () => {
    const octokit = new FixtureOctokit();
    octokit.failures.push({
      route: "GET /repos/{owner}/{repo}/git/ref/{ref}",
      status: 404,
      message: "Not Found",
      remaining: 1,
    });
    const client = new OctokitGitHubClient({ app: fixtureApp(octokit) });

    await expect(client.getRef(42, REPO, `heads/${BRANCH}`)).resolves.toBeNull();
  });

  it("stops after the bounded retry budget", async () => {
    const octokit = new FixtureOctokit();
    octokit.failures.push({
      route: "GET /app/installations",
      status: 503,
      message: "still unavailable",
      remaining: 4,
    });
    const client = new OctokitGitHubClient({
      app: fixtureApp(octokit),
      maxRetries: 2,
      sleep: () => Promise.resolve(),
    });

    await expect(client.listInstallations()).rejects.toMatchObject({
      category: "github_unavailable",
      status: 503,
    });
    expect(octokit.pagination).toHaveLength(3);
  });
});
