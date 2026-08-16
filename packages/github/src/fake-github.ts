import type { Installation, Issue, PullRequest, RepoRef, Repository } from "@rivet/contracts";
import {
  classifyGitHubResponse,
  type CreatePullRequestInput,
  type GitHubClient,
  type GitHubResponse,
  type GitHubToken,
  type RefState,
  type TokenScope,
  type UpdatePullRequestInput,
} from "@rivet/core";

import { GitHubInstallationToken } from "./github-client";

export type FakeGitHubMethod =
  | "listInstallations"
  | "listRepositories"
  | "listIssues"
  | "mintInstallationToken"
  | "getRef"
  | "findPullRequest"
  | "createPullRequest"
  | "updatePullRequest";

/** A safe, ordered record of calls made to the fake. */
export interface FakeGitHubCall {
  method: FakeGitHubMethod;
  installationId?: number;
  repo?: RepoRef;
  ref?: string;
  head?: string;
  scope?: TokenScope;
  input?: CreatePullRequestInput | UpdatePullRequestInput;
}

/** A provider-shaped response that the fake turns into a domain error. */
export interface FakeGitHubFailure {
  method: FakeGitHubMethod;
  response?: GitHubResponse;
  error?: Error;
  /** Number of matching calls to fail. Defaults to one. */
  times?: number;
}

export interface FakeGitHubOptions {
  installations?: readonly Installation[];
  repositories?: readonly Repository[];
  repositoriesByInstallation?: Readonly<Record<string, readonly Repository[]>>;
  issues?: readonly Issue[];
  issuesByRepository?: Readonly<Record<string, readonly Issue[]>>;
  refs?: Readonly<Record<string, RefState | null>>;
  pullRequests?: readonly PullRequest[];
  failures?: readonly FakeGitHubFailure[];
  tokenValue?: string;
  tokenExpiresAt?: Date;
}

/**
 * A deterministic GitHub port fake.
 *
 * It deliberately models provider failures at the port boundary rather than
 * pretending to be an HTTP server. Adapter retry behaviour belongs to the
 * recorded-response tests; pipeline and reconciliation tests need a small
 * fake that can say "the next ref lookup is a 404" and show every call in
 * order.
 */
export class FakeGitHubClient implements GitHubClient {
  readonly calls: FakeGitHubCall[] = [];

  private readonly installations: Installation[];
  private readonly repositories: Repository[];
  private readonly repositoriesByInstallation: Readonly<Record<string, readonly Repository[]>>;
  private readonly issues: Issue[];
  private readonly issuesByRepository: Readonly<Record<string, readonly Issue[]>>;
  private readonly refs = new Map<string, RefState | null>();
  private readonly pullRequests: PullRequest[];
  private readonly failures: FakeGitHubFailure[];
  private readonly tokenValue: string;
  private readonly tokenExpiresAt: Date;
  private nextPullRequestNumber: number;

  constructor(options: FakeGitHubOptions = {}) {
    this.installations = [...(options.installations ?? [])];
    this.repositories = [...(options.repositories ?? [])];
    this.repositoriesByInstallation = options.repositoriesByInstallation ?? {};
    this.issues = [...(options.issues ?? [])];
    this.issuesByRepository = options.issuesByRepository ?? {};
    this.pullRequests = [...(options.pullRequests ?? [])];
    this.failures = [...(options.failures ?? [])].map((failure) => ({
      ...failure,
      ...(failure.response === undefined ? {} : { response: { ...failure.response } }),
      times: failure.times ?? 1,
    }));
    this.tokenValue = options.tokenValue ?? "fake-github-token";
    this.tokenExpiresAt = options.tokenExpiresAt ?? new Date(Date.now() + 60 * 60 * 1_000);
    this.nextPullRequestNumber =
      Math.max(0, ...this.pullRequests.map((pullRequest) => pullRequest.number)) + 1;

    for (const [key, ref] of Object.entries(options.refs ?? {})) this.refs.set(key, ref);
  }

  listInstallations(): Promise<Installation[]> {
    return this.run("listInstallations", {}, () => this.installations.map(copyInstallation));
  }

  listRepositories(installationId: number): Promise<Repository[]> {
    return this.run("listRepositories", { installationId }, () => {
      const scoped = this.repositoriesByInstallation[String(installationId)];
      return (scoped ?? this.repositories).map(copyRepository);
    });
  }

  listIssues(installationId: number, repo: RepoRef): Promise<Issue[]> {
    return this.run("listIssues", { installationId, repo }, () => {
      const scoped = this.issuesByRepository[repoKey(repo)];
      return (scoped ?? this.issues).map(copyIssue);
    });
  }

  mintInstallationToken(
    installationId: number,
    repo: RepoRef,
    scope: TokenScope,
  ): Promise<GitHubToken> {
    return this.run(
      "mintInstallationToken",
      { installationId, repo, scope },
      () => new GitHubInstallationToken(this.tokenValue, this.tokenExpiresAt),
    );
  }

  getRef(installationId: number, repo: RepoRef, ref: string): Promise<RefState | null> {
    return this.run(
      "getRef",
      { installationId, repo, ref },
      () => this.refs.get(refKey(repo, ref)) ?? null,
    );
  }

  findPullRequest(
    installationId: number,
    repo: RepoRef,
    head: string,
  ): Promise<PullRequest | null> {
    return this.run("findPullRequest", { installationId, repo, head }, () => {
      const pullRequest = this.pullRequests.find(
        (candidate) => candidate.branch === head && candidate.url.includes(`/${repo.name}/`),
      );
      return pullRequest === undefined ? null : copyPullRequest(pullRequest);
    });
  }

  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    return this.run("createPullRequest", { input }, () => {
      const pullRequest: PullRequest = {
        nodeId: `fake-pr-node-${this.nextPullRequestNumber}`,
        number: this.nextPullRequestNumber,
        url: `https://github.com/${input.repo.owner}/${input.repo.name}/pull/${this.nextPullRequestNumber}`,
        branch: input.head,
        state: "open",
      };
      this.nextPullRequestNumber += 1;
      this.pullRequests.push(pullRequest);
      return copyPullRequest(pullRequest);
    });
  }

  updatePullRequest(input: UpdatePullRequestInput): Promise<PullRequest> {
    return this.run("updatePullRequest", { input }, () => {
      const pullRequest = this.pullRequests.find((candidate) => candidate.number === input.number);
      if (pullRequest === undefined) {
        throw new Error(`Fake pull request ${input.number} does not exist.`);
      }
      return copyPullRequest(pullRequest);
    });
  }

  /** Fails the next matching call with a provider-shaped response. */
  failNext(method: FakeGitHubMethod, response: GitHubResponse): void {
    this.failures.push({ method, response, times: 1 });
  }

  /** Adds a failure that remains active for the requested number of calls. */
  fail(method: FakeGitHubMethod, response: GitHubResponse, times = 1): void {
    if (!Number.isInteger(times) || times < 1)
      throw new Error("Fake failure times must be positive.");
    this.failures.push({ method, response, times });
  }

  /** Sets the remote ref returned by subsequent reconciliation calls. */
  setRef(repo: RepoRef, ref: string, state: RefState | null): void {
    this.refs.set(refKey(repo, ref), state);
  }

  /** Adds or replaces a pull request returned by head lookup. */
  setPullRequest(pullRequest: PullRequest): void {
    const existing = this.pullRequests.findIndex(
      (candidate) => candidate.number === pullRequest.number,
    );
    if (existing < 0) this.pullRequests.push(copyPullRequest(pullRequest));
    else this.pullRequests[existing] = copyPullRequest(pullRequest);
    this.nextPullRequestNumber = Math.max(this.nextPullRequestNumber, pullRequest.number + 1);
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  private run<T>(
    method: FakeGitHubMethod,
    call: Omit<FakeGitHubCall, "method">,
    result: () => T,
  ): Promise<T> {
    return Promise.resolve().then(() => {
      this.calls.push({ method, ...call });
      const failure = this.takeFailure(method);
      if (failure) {
        if (failure.error) throw failure.error;
        throw classifyGitHubResponse(
          failure.response ?? { status: 503, message: `Fake ${method} failure` },
          operationFor(method),
        );
      }
      return result();
    });
  }

  private takeFailure(method: FakeGitHubMethod): FakeGitHubFailure | undefined {
    const failure = this.failures.find(
      (candidate) => candidate.method === method && (candidate.times ?? 0) > 0,
    );
    if (!failure) return undefined;
    failure.times = (failure.times ?? 1) - 1;
    return failure;
  }
}

function operationFor(method: FakeGitHubMethod): "installation" | "repository" | "pull_request" {
  if (method === "listInstallations" || method === "mintInstallationToken") return "installation";
  if (method === "createPullRequest" || method === "updatePullRequest") return "pull_request";
  return "repository";
}

function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

function refKey(repo: RepoRef, ref: string): string {
  return `${repoKey(repo)}#${ref.replace(/^refs\//, "")}`;
}

function copyInstallation(value: Installation): Installation {
  return { ...value, permissions: { ...value.permissions } };
}

function copyRepository(value: Repository): Repository {
  return { ...value };
}

function copyIssue(value: Issue): Issue {
  return { ...value };
}

function copyPullRequest(value: PullRequest): PullRequest {
  return { ...value };
}
