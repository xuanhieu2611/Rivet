import { describe, expect, it } from "vitest";

import {
  classify,
  failureCategoryFor,
  GitHubNotInstalledError,
  GitHubPermissionDeniedError,
  GitHubUnavailableError,
  PullRequestFailedError,
  PushRejectedError,
} from "../index";
import type {
  CreatePullRequestInput,
  GitHubClient,
  GitHubToken,
  RefState,
  TokenScope,
  UpdatePullRequestInput,
} from "./github";
import { classifyGitHubResponse, GITHUB_FAILURE_CATEGORIES } from "./errors";

const REPO = { owner: "acme", name: "widgets" };

/** A small compile-time consumer of the port, with no adapter or network. */
class ScriptedGitHubClient implements GitHubClient {
  listInstallations() {
    return Promise.resolve([]);
  }

  listRepositories(_installationId: number) {
    return Promise.resolve([]);
  }

  listIssues(_installationId: number, _repo: typeof REPO) {
    return Promise.resolve([]);
  }

  mintInstallationToken(
    _installationId: number,
    _repo: typeof REPO,
    _scope: TokenScope,
  ): Promise<GitHubToken> {
    return Promise.resolve({
      value: "token",
      expiresAt: new Date(0),
      redact: () => "[REDACTED]",
    });
  }

  getRef(_installationId: number, _repo: typeof REPO, _ref: string): Promise<RefState | null> {
    return Promise.resolve(null);
  }

  findPullRequest(_installationId: number, _repo: typeof REPO, _head: string) {
    return Promise.resolve(null);
  }

  createPullRequest(_input: CreatePullRequestInput) {
    return Promise.resolve({
      nodeId: "node-1",
      number: 1,
      url: "https://github.com/acme/widgets/pull/1",
      branch: "rivet/job-1234-fix",
      state: "open" as const,
    });
  }

  updatePullRequest(_input: UpdatePullRequestInput) {
    return this.createPullRequest({
      installationId: 1,
      repo: REPO,
      head: "rivet/job-1234-fix",
      base: "main",
      title: "Fix",
      body: "body",
    });
  }
}

describe("GitHub provider port", () => {
  it("keeps the publication inputs in domain terms", async () => {
    const client = new ScriptedGitHubClient();
    const token = await client.mintInstallationToken(1, REPO, "read");
    const ref = await client.getRef(1, REPO, "heads/main");

    expect(token.redact()).toBe("[REDACTED]");
    expect(ref).toBeNull();
    await expect(
      client.createPullRequest({
        installationId: 1,
        repo: REPO,
        head: "rivet/job-1234-fix",
        base: "main",
        title: "Fix",
        body: "body",
      }),
    ).resolves.toMatchObject({ state: "open" });
  });
});

describe("GitHub response classification", () => {
  it.each([
    [{}, "repository", GitHubUnavailableError, "github_unavailable"],
    [{ status: 429 }, "pull_request", GitHubUnavailableError, "github_unavailable"],
    [{ status: 503 }, "repository", GitHubUnavailableError, "github_unavailable"],
    [{ status: 403 }, "repository", GitHubPermissionDeniedError, "github_permission_denied"],
    [{ status: 404 }, "repository", GitHubPermissionDeniedError, "github_permission_denied"],
    [{ status: 404 }, "installation", GitHubNotInstalledError, "github_not_installed"],
    [{ status: 422 }, "pull_request", PullRequestFailedError, "pull_request_failed"],
  ] as const)("maps %j from %s", (response, operation, ErrorType, category) => {
    const error = classifyGitHubResponse(response, operation, {
      cause: new Error("provider response"),
    });

    expect(error).toBeInstanceOf(ErrorType);
    expect(classify(error)).toBe(category === "github_unavailable" ? "retryable" : "terminal");
    expect(failureCategoryFor(error)).toBe(category);
    expect(error.cause).toEqual(new Error("provider response"));
  });

  it("keeps retry metadata without exposing a token", () => {
    const error = new GitHubUnavailableError("rate limited", {
      status: 429,
      retryAfterMs: 1_500,
    });

    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(1_500);
    expect(error.message).not.toContain("token");
  });

  it("maps a host push refusal to its terminal category", () => {
    const error = new PushRejectedError("remote rejected the ref update");

    expect(classify(error)).toBe("terminal");
    expect(failureCategoryFor(error)).toBe("push_rejected");
  });

  it("lists exactly the categories introduced by the GitHub port", () => {
    expect(GITHUB_FAILURE_CATEGORIES).toEqual([
      "github_unavailable",
      "github_permission_denied",
      "push_rejected",
      "pull_request_failed",
      "github_not_installed",
    ]);
  });
});
