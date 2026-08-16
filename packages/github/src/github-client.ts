import type { Installation, Issue, PullRequest, RepoRef, Repository } from "@rivet/contracts";
import {
  classifyGitHubResponse,
  GitHubUnavailableError,
  type GitHubClient,
  type GitHubToken,
  type RefState,
  type TokenScope,
} from "@rivet/core";

import {
  getGitHubApp,
  type GitHubAppHandle,
  type GitHubAppConfig,
  type GitHubOctokit,
  type GitHubOctokitResponse,
} from "./app";

/** A sleep function is injectable so retry tests never wait on a real clock. */
export type GitHubSleep = (delayMs: number) => Promise<void>;

/** The retry policy applied inside the adapter, before a job sees an error. */
export interface GitHubRetryOptions {
  /** Number of retries after the first request. Defaults to three. */
  maxRetries?: number;
  /** Base exponential backoff in milliseconds. Defaults to 250. */
  initialDelayMs?: number;
  /** Upper bound for one backoff or Retry-After delay. Defaults to 30 seconds. */
  maxDelayMs?: number;
  sleep?: GitHubSleep;
  /** Injectable jitter source, returning a value in the inclusive [0, 1] range. */
  random?: () => number;
}

/** Construction options for the real Octokit-backed client. */
export interface GitHubClientOptions extends GitHubRetryOptions {
  /** A real or test double App. Supplying it avoids reading the environment. */
  app?: GitHubAppHandle;
  /** Credentials used by the lazy App when `app` is not supplied. */
  appConfig?: GitHubAppConfig;
}

export const DEFAULT_GITHUB_RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 250,
  maxDelayMs: 30_000,
} as const;

const readPermissions = { contents: "read" };
const writePermissions = { contents: "write", pull_requests: "write" };

/**
 * The real GitHub adapter. Octokit request details stop at this file; callers
 * see only the domain port from `@rivet/core`.
 */
export class OctokitGitHubClient implements GitHubClient {
  private readonly app: GitHubAppHandle;
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: GitHubSleep;
  private readonly random: () => number;

  constructor(options: GitHubClientOptions = {}) {
    this.app = options.app ?? getGitHubApp(options.appConfig);
    this.maxRetries = nonNegativeInteger(
      options.maxRetries ?? DEFAULT_GITHUB_RETRY_OPTIONS.maxRetries,
    );
    this.initialDelayMs = nonNegativeNumber(
      options.initialDelayMs ?? DEFAULT_GITHUB_RETRY_OPTIONS.initialDelayMs,
    );
    this.maxDelayMs = nonNegativeNumber(
      options.maxDelayMs ?? DEFAULT_GITHUB_RETRY_OPTIONS.maxDelayMs,
    );
    this.sleep = options.sleep ?? sleep;
    this.random = options.random ?? Math.random;
  }

  async listInstallations(): Promise<Installation[]> {
    const installations = await this.paginate<unknown>(
      "installation",
      this.app.octokit,
      "GET /app/installations",
      { per_page: 100 },
    );
    return installations.map(mapInstallation);
  }

  async listRepositories(installationId: number): Promise<Repository[]> {
    const repositories = await this.paginate<unknown>(
      "repository",
      await this.installationOctokit(installationId),
      "GET /installation/repositories",
      { per_page: 100 },
    );
    return repositories.map(mapRepository);
  }

  async listIssues(installationId: number, repo: RepoRef): Promise<Issue[]> {
    const issues = await this.paginate<unknown>(
      "repository",
      await this.installationOctokit(installationId),
      "GET /repos/{owner}/{repo}/issues",
      { owner: repo.owner, repo: repo.name, state: "all", per_page: 100 },
    );

    // GitHub's issues endpoint includes pull requests. A PR is not an issue in
    // Rivet's picker, even though both are represented by an issue-shaped API
    // object, so filter it before mapping.
    return issues.filter((issue) => !hasPullRequestMarker(issue)).map(mapIssue);
  }

  async mintInstallationToken(
    installationId: number,
    repo: RepoRef,
    scope: TokenScope,
  ): Promise<GitHubToken> {
    const permissions = scope === "read" ? readPermissions : writePermissions;
    const authentication = await this.withRetry("installation", async () => ({
      data: await this.app.octokit.auth({
        type: "installation",
        installationId,
        // GitHub expects repository names rather than owner/name pairs. The
        // installation already determines the owner, while this keeps a token
        // from reaching another repository in the same installation.
        repositoryNames: [repo.name],
        permissions,
      }),
    }));

    const expiresAt = new Date(authentication.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error("GitHub returned an invalid installation-token expiry.");
    }
    return new GitHubInstallationToken(authentication.token, expiresAt);
  }

  async getRef(installationId: number, repo: RepoRef, ref: string): Promise<RefState | null> {
    const octokit = await this.installationOctokit(installationId);
    const normalizedRef = ref.replace(/^refs\//, "");

    let refData: RefResponse;
    try {
      refData = await this.request<RefResponse>(
        "repository",
        octokit,
        "GET /repos/{owner}/{repo}/git/ref/{ref}",
        { owner: repo.owner, repo: repo.name, ref: normalizedRef },
      );
    } catch (error) {
      // A missing branch is a normal reconciliation answer. The same HTTP 404
      // can also represent an inaccessible repository, but GitHub's refs API
      // does not distinguish those cases; callers still get the documented
      // null for this endpoint and repository discovery catches access failures.
      if (statusOf(error) === 404) return null;
      throw error;
    }

    const commitSha = refData.object.sha;
    const commit = await this.request<CommitResponse>(
      "repository",
      octokit,
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      { owner: repo.owner, repo: repo.name, commit_sha: commitSha },
    );

    return {
      commitSha,
      treeSha: commit.tree.sha,
    };
  }

  async findPullRequest(
    installationId: number,
    repo: RepoRef,
    head: string,
  ): Promise<PullRequest | null> {
    const pulls = await this.paginate<unknown>(
      "pull_request",
      await this.installationOctokit(installationId),
      "GET /repos/{owner}/{repo}/pulls",
      {
        owner: repo.owner,
        repo: repo.name,
        head: `${repo.owner}:${head}`,
        state: "all",
        per_page: 100,
      },
    );
    const pull = pulls.find((candidate) => pullBranch(candidate) === head);
    return pull === undefined ? null : mapPullRequest(pull);
  }

  async createPullRequest(
    input: Parameters<GitHubClient["createPullRequest"]>[0],
  ): Promise<PullRequest> {
    const pull = await this.request<unknown>(
      "pull_request",
      await this.installationOctokit(input.installationId),
      "POST /repos/{owner}/{repo}/pulls",
      {
        owner: input.repo.owner,
        repo: input.repo.name,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
      },
    );
    return mapPullRequest(pull);
  }

  async updatePullRequest(
    input: Parameters<GitHubClient["updatePullRequest"]>[0],
  ): Promise<PullRequest> {
    const pull = await this.request<unknown>(
      "pull_request",
      await this.installationOctokit(input.installationId),
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: input.repo.owner,
        repo: input.repo.name,
        pull_number: input.number,
        body: input.body,
        ...(input.title === undefined ? {} : { title: input.title }),
      },
    );
    return mapPullRequest(pull);
  }

  private async installationOctokit(installationId: number): Promise<GitHubOctokit> {
    return this.app.getInstallationOctokit(installationId);
  }

  private async paginate<T>(
    operation: "installation" | "repository" | "pull_request",
    octokit: GitHubOctokit,
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<T[]> {
    return this.withRetry(operation, async () => ({
      data: await octokit.paginate<T>(route, parameters),
    }));
  }

  private async request<T>(
    operation: "installation" | "repository" | "pull_request",
    octokit: GitHubOctokit,
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<T> {
    return this.withRetry(operation, async () => {
      const response = await octokit.request<T>(route, parameters);
      if (response.status !== undefined && response.status >= 400) {
        throw new GitHubHttpError(response);
      }
      return response;
    });
  }

  /**
   * Retries only the provider failures classified as unavailable. Permission,
   * malformed-request and pull-request failures cross the port immediately so
   * the worker does not retry a terminal publication error as a whole job.
   */
  private async withRetry<T>(
    operation: "installation" | "repository" | "pull_request",
    action: () => Promise<GitHubOctokitResponse<T>>,
  ): Promise<T> {
    let retryCount = 0;

    while (true) {
      try {
        const response = await action();
        return response.data;
      } catch (cause) {
        const status = statusOf(cause);
        const retryAfterMs = retryAfterOf(cause);
        const response = {
          ...(status === undefined ? {} : { status }),
          message: messageOf(cause) ?? `GitHub ${operation} request failed`,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
        const classified = classifyGitHubResponse(response, operation, { cause });

        if (!(classified instanceof GitHubUnavailableError) || retryCount >= this.maxRetries) {
          throw classified;
        }

        const delay = this.retryDelay(classified.retryAfterMs, retryCount);
        retryCount += 1;
        await this.sleep(delay);
      }
    }
  }

  private retryDelay(retryAfterMs: number | undefined, retryCount: number): number {
    const exponential = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** retryCount);
    // Retry-After is a lower bound from the provider. The exponential branch is
    // still jittered, which prevents several workers that hit the same limit
    // from waking up in lockstep.
    const jittered = Math.floor(exponential * (0.5 + this.random() * 0.5));
    return Math.min(this.maxDelayMs, Math.max(retryAfterMs ?? 0, jittered));
  }
}

/** The value object returned by the token minter. */
export class GitHubInstallationToken implements GitHubToken {
  constructor(
    readonly value: string,
    readonly expiresAt: Date,
  ) {}

  redact(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return this.redact();
  }

  toJSON(): string {
    return this.redact();
  }
}

/** Creates a real adapter, using the lazy App unless a test App is supplied. */
export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  return new OctokitGitHubClient(options);
}

/** A process-wide adapter for the worker's normal App configuration. */
const globalForClient = globalThis as unknown as { __rivetGitHubClient?: GitHubClient };
let client: GitHubClient | undefined;

export function getGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  client ??= globalForClient.__rivetGitHubClient;
  if (client) return client;

  client = createGitHubClient(options);
  if (process.env.NODE_ENV !== "production") {
    globalForClient.__rivetGitHubClient = client;
  }
  return client;
}

export function resetGitHubClient(): void {
  client = undefined;
  delete globalForClient.__rivetGitHubClient;
}

interface RefResponse {
  object: { sha: string };
}

interface CommitResponse {
  tree: { sha: string };
}

function mapInstallation(value: unknown): Installation {
  const record = objectOf(value, "installation");
  const account = objectOf(record.account, "installation.account");
  return {
    id: numberOf(record.id, "installation.id"),
    accountLogin: stringOf(account.login, "installation.account.login"),
    accountType: stringOf(account.type, "installation.account.type"),
    targetType: stringOf(record.target_type, "installation.target_type"),
    permissions: record.permissions === undefined ? {} : permissionsOf(record.permissions),
    suspended: record.suspended_at !== null && record.suspended_at !== undefined,
  };
}

function mapRepository(value: unknown): Repository {
  const record = objectOf(value, "repository");
  const owner = objectOf(record.owner, "repository.owner");
  return {
    id: numberOf(record.id, "repository.id"),
    owner: stringOf(owner.login, "repository.owner.login"),
    name: stringOf(record.name, "repository.name"),
    private: booleanOf(record.private, "repository.private"),
    defaultBranch: stringOf(record.default_branch, "repository.default_branch"),
  };
}

function mapIssue(value: unknown): Issue {
  const record = objectOf(value, "issue");
  const state = record.state;
  if (state !== "open" && state !== "closed") {
    throw new Error("GitHub returned an issue with an unsupported state.");
  }
  return {
    number: numberOf(record.number, "issue.number"),
    title: stringOf(record.title, "issue.title"),
    body: record.body === null ? null : stringOf(record.body, "issue.body"),
    htmlUrl: stringOf(record.html_url, "issue.html_url"),
    state,
  };
}

function mapPullRequest(value: unknown): PullRequest {
  const record = objectOf(value, "pull request");
  const branch = pullBranch(record);
  const state = pullState(record);
  return {
    nodeId: stringOf(record.node_id, "pull request.node_id"),
    number: numberOf(record.number, "pull request.number"),
    url: stringOf(record.html_url, "pull request.html_url"),
    branch,
    state,
  };
}

function pullBranch(value: unknown): string {
  const record = objectOf(value, "pull request");
  const head = objectOf(record.head, "pull request.head");
  return stringOf(head.ref, "pull request.head.ref");
}

function pullState(value: unknown): PullRequest["state"] {
  const record = objectOf(value, "pull request");
  if (record.merged_at !== null && record.merged_at !== undefined) return "merged";
  if (record.state === "open" || record.state === "closed") return record.state;
  throw new Error("GitHub returned a pull request with an unsupported state.");
}

function hasPullRequestMarker(value: unknown): boolean {
  return objectOf(value, "issue").pull_request !== undefined;
}

function permissionsOf(value: unknown): Record<string, string> {
  const record = objectOf(value, "permissions");
  return Object.fromEntries(
    Object.entries(record).map(([key, permission]) => [
      key,
      stringOf(permission, `permissions.${key}`),
    ]),
  );
}

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GitHub returned an invalid ${field}.`);
  }
  return value as Record<string, unknown>;
}

function stringOf(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`GitHub returned an invalid ${field}.`);
  return value;
}

function numberOf(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`GitHub returned an invalid ${field}.`);
  }
  return value;
}

function booleanOf(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`GitHub returned an invalid ${field}.`);
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("GitHub retry counts must be non-negative integers.");
  }
  return value;
}

function nonNegativeNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("GitHub retry delays must be non-negative numbers.");
  }
  return value;
}

function statusOf(value: unknown): number | undefined {
  const record = recordOf(value);
  const response = recordOf(record?.response);
  const status = response?.status ?? record?.status;
  return typeof status === "number" ? status : undefined;
}

function messageOf(value: unknown): string | undefined {
  const record = recordOf(value);
  const response = recordOf(record?.response);
  const data = recordOf(response?.data);
  if (typeof data?.message === "string") return data.message;
  if (typeof record?.message === "string") return record.message;
  return undefined;
}

function retryAfterOf(value: unknown): number | undefined {
  const record = recordOf(value);
  const response = recordOf(record?.response);
  const headers = response?.headers ?? record?.headers;
  if (headers === undefined) return undefined;

  let raw: unknown;
  if (typeof headers === "object" && headers !== null) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "retry-after") {
        raw = value;
        break;
      }
    }
  }
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, raw * 1_000);
  if (typeof raw !== "string") return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

class GitHubHttpError extends Error {
  readonly response: GitHubOctokitResponse<unknown>;

  constructor(response: GitHubOctokitResponse<unknown>) {
    super(`GitHub returned HTTP ${response.status ?? "an error"}.`);
    this.name = "GitHubHttpError";
    this.response = response;
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
