import type { FailureCategory } from "@rivet/contracts";

import { TerminalJobError } from "../jobs/failure";

/** Details that can safely cross the adapter boundary with a GitHub failure. */
export interface GitHubErrorOptions {
  cause?: unknown;
  /** The HTTP status, when GitHub returned one. Absent for transport failures. */
  status?: number;
  /** Parsed Retry-After delay, in milliseconds, when GitHub supplied one. */
  retryAfterMs?: number;
}

/** A response shape the adapter can map without importing an HTTP client here. */
export interface GitHubResponse {
  status?: number;
  message?: string;
  retryAfterMs?: number;
}

/** Which domain operation received the provider response. */
export type GitHubResponseOperation = "installation" | "repository" | "pull_request";

/**
 * GitHub could not be reached, is rate limiting us, or returned a server error.
 *
 * Terminal, and deliberately so despite being the one GitHub failure a repeat
 * could get past. The repeat that is worth making is the adapter's: bounded,
 * jittered, and honouring `Retry-After`, close enough to the request to be one
 * call rather than one attempt. A runner-level retry re-runs the entire job
 * from provisioning to reach the same publication - safe by construction,
 * because the receipt protocol makes the external effect idempotent, but it
 * spends a container, a clone and a model session to repeat one HTTP call, and
 * turns a GitHub outage into three identical timelines. The adapter has already
 * given up by the time this reaches a phase.
 */
export class GitHubUnavailableError extends TerminalJobError {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: GitHubErrorOptions = {}) {
    super(message, "github_unavailable", options);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** The installation cannot access the repository or GitHub denied the request. */
export class GitHubPermissionDeniedError extends TerminalJobError {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: GitHubErrorOptions = {}) {
    super(message, "github_permission_denied", options);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Git refused to update the publication branch. */
export class PushRejectedError extends TerminalJobError {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: GitHubErrorOptions = {}) {
    super(message, "push_rejected", options);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** The branch exists, but GitHub refused or failed the pull-request operation. */
export class PullRequestFailedError extends TerminalJobError {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: GitHubErrorOptions = {}) {
    super(message, "pull_request_failed", options);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** The job's installation binding is no longer present in GitHub. */
export class GitHubNotInstalledError extends TerminalJobError {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: GitHubErrorOptions = {}) {
    super(message, "github_not_installed", options);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Maps an adapter-neutral provider response to the failure the pipeline should
 * persist. Transport failures have no status, rate limits are 429s, and 5xx
 * responses are the only cases that are retryable. A 403 or 404 on a bound
 * repository is a permission problem, not an invitation to repeat a write.
 *
 * Operation-specific terminal categories keep the job's final failure useful:
 * an unavailable installation binding is `github_not_installed`, while a
 * non-transient pull-request response is `pull_request_failed`.
 */
export function classifyGitHubResponse(
  response: GitHubResponse,
  operation: GitHubResponseOperation,
  options: { cause?: unknown } = {},
):
  | GitHubUnavailableError
  | GitHubPermissionDeniedError
  | GitHubNotInstalledError
  | PullRequestFailedError {
  const status = response.status;
  const details: GitHubErrorOptions = {
    ...(status === undefined ? {} : { status }),
    ...(response.retryAfterMs === undefined ? {} : { retryAfterMs: response.retryAfterMs }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  };
  const message = response.message ?? `GitHub ${operation} request failed`;

  if (
    status === undefined ||
    status === 429 ||
    status >= 500 ||
    response.retryAfterMs !== undefined
  ) {
    return new GitHubUnavailableError(message, details);
  }

  if (status === 403 || status === 404) {
    if (operation === "installation") {
      return new GitHubNotInstalledError(message, details);
    }
    return new GitHubPermissionDeniedError(message, details);
  }

  if (operation === "installation") {
    return new GitHubNotInstalledError(message, details);
  }
  if (operation === "pull_request") {
    return new PullRequestFailedError(message, details);
  }
  return new GitHubPermissionDeniedError(message, details);
}

/** The categories raised by GitHub discovery and publication. */
export const GITHUB_FAILURE_CATEGORIES = [
  "github_unavailable",
  "github_permission_denied",
  "push_rejected",
  "pull_request_failed",
  "github_not_installed",
] as const satisfies readonly FailureCategory[];
