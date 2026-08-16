import type {
  CreatePullRequestInput,
  GitHubClient,
  GitHubPipelineOptions,
  GitHubToken,
  RefState,
  TokenScope,
  UpdatePullRequestInput,
} from "@rivet/core";
import type { Installation, Issue, PullRequest, RepoRef, Repository } from "@rivet/contracts";
import { createGitHubClient } from "@rivet/github";

import type { GitHubConfig } from "./config";
import { publish, seedClone } from "./git";
import type { SecretRegistry } from "./secrets";

/**
 * The worker's half of `RIVET_GITHUB`.
 *
 * Three things are assembled here and nowhere else: the Octokit adapter with
 * the App credentials `parseWorkerConfig` already validated, the two host Git
 * operations - the only code in the system that runs `git` outside a container
 * - and the bounds they run under. `@rivet/core` receives them as one optional
 * field, which is what keeps the package free of both Octokit and the
 * environment.
 *
 * Returns `undefined` under `RIVET_GITHUB=off`, which leaves
 * `PipelineOptions.github` absent, the in-container clone path in place and
 * `finalizing` recording `publication.skipped`.
 */
export function createGitHubOptions(
  config: GitHubConfig,
  secrets: SecretRegistry,
): GitHubPipelineOptions | undefined {
  if (config.mode === "off") return undefined;

  const client = withTokenRegistration(
    createGitHubClient({
      // Passed explicitly rather than read from the environment by the adapter:
      // the worker validated and decoded these at startup, and one place that
      // knows how a PEM arrives is enough.
      appConfig: { appId: config.appId ?? "", privateKey: config.privateKey ?? "" },
    }),
    secrets,
  );

  return {
    client,
    seedClone,
    publish,
    seedMaxBytes: config.seedMaxBytes,
    cloneTimeoutMs: config.cloneTimeoutMs,
    pushTimeoutMs: config.pushTimeoutMs,
  };
}

/** Wraps a client so every token it mints is known to log redaction. */
export function withTokenRegistration(client: GitHubClient, secrets: SecretRegistry): GitHubClient {
  return new TokenRegisteringClient(client, secrets);
}

/**
 * Registers every minted token with log redaction as it is created.
 *
 * A decorator rather than a hook inside the adapter, because the adapter has no
 * business knowing what a logger is and this is the one place a token is
 * created. It is deliberately the outermost wrapper: a token is registered
 * before it is ever returned to a caller, so there is no window in which a live
 * credential exists and the redaction pass does not know about it.
 */
class TokenRegisteringClient implements GitHubClient {
  constructor(
    private readonly inner: GitHubClient,
    private readonly secrets: SecretRegistry,
  ) {}

  async mintInstallationToken(
    installationId: number,
    repo: RepoRef,
    scope: TokenScope,
  ): Promise<GitHubToken> {
    const token = await this.inner.mintInstallationToken(installationId, repo, scope);
    this.secrets.add(token.value, token.expiresAt);
    return token;
  }

  listInstallations(): Promise<Installation[]> {
    return this.inner.listInstallations();
  }

  listRepositories(installationId: number): Promise<Repository[]> {
    return this.inner.listRepositories(installationId);
  }

  listIssues(installationId: number, repo: RepoRef): Promise<Issue[]> {
    return this.inner.listIssues(installationId, repo);
  }

  getRef(installationId: number, repo: RepoRef, ref: string): Promise<RefState | null> {
    return this.inner.getRef(installationId, repo, ref);
  }

  findPullRequest(
    installationId: number,
    repo: RepoRef,
    head: string,
  ): Promise<PullRequest | null> {
    return this.inner.findPullRequest(installationId, repo, head);
  }

  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    return this.inner.createPullRequest(input);
  }

  updatePullRequest(input: UpdatePullRequestInput): Promise<PullRequest> {
    return this.inner.updatePullRequest(input);
  }
}
