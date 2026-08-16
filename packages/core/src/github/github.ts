/**
 * The GitHub PORT: the domain's view of GitHub, and nothing from Octokit.
 *
 * The adapter in `packages/github` owns App authentication, HTTP details,
 * retries and response mapping. Keeping those details out of core means the
 * worker can use a fake in tests and the package remains importable without a
 * GitHub credential or network access.
 */

import type { Installation, Issue, PullRequest, RepoRef, Repository } from "@rivet/contracts";

/** The permission level requested when minting an installation token. */
export type TokenScope = "read" | "write";

/**
 * A short-lived installation token.
 *
 * The token value is intentionally kept in a small value object so callers can
 * register it with log redaction before using it. It is never a job artifact or
 * a value passed to the sandbox.
 */
export interface GitHubToken {
  value: string;
  expiresAt: Date;
  redact(): string;
}

/** The commit and tree currently pointed at by a remote ref. */
export interface RefState {
  commitSha: string;
  treeSha: string;
}

/** The information needed to open a pull request through the provider. */
export interface CreatePullRequestInput {
  installationId: number;
  repo: RepoRef;
  head: string;
  base: string;
  title: string;
  body: string;
}

/** The information needed to update an already discovered pull request. */
export interface UpdatePullRequestInput {
  installationId: number;
  repo: RepoRef;
  number: number;
  body: string;
  title?: string;
}

/**
 * The provider port used by repository discovery and publication.
 *
 * Methods take domain values rather than Octokit's request objects. The
 * installation id is explicit on every operation that needs a token so an
 * adapter cannot accidentally use a token minted for another installation.
 */
export interface GitHubClient {
  listInstallations(): Promise<Installation[]>;
  listRepositories(installationId: number): Promise<Repository[]>;
  listIssues(installationId: number, repo: RepoRef): Promise<Issue[]>;

  /** Short-lived and minted per use, never cached in Postgres. */
  mintInstallationToken(
    installationId: number,
    repo: RepoRef,
    scope: TokenScope,
  ): Promise<GitHubToken>;

  /** Returns null when the ref does not exist. */
  getRef(installationId: number, repo: RepoRef, ref: string): Promise<RefState | null>;

  /** Finds a pull request whose head is the supplied branch identity. */
  findPullRequest(installationId: number, repo: RepoRef, head: string): Promise<PullRequest | null>;

  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  updatePullRequest(input: UpdatePullRequestInput): Promise<PullRequest>;
}
