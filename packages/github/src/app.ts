import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

/** Configuration needed to sign a GitHub App JWT. */
export interface GitHubAppConfig {
  appId: number | string;
  privateKey: string;
}

/** A small, adapter-local view of an Octokit App. */
export interface GitHubAppHandle {
  readonly octokit: GitHubOctokit;
  getInstallationOctokit(installationId: number): Promise<GitHubOctokit>;
}

/** The subset of Octokit used by the GitHub port. */
export interface GitHubOctokit {
  auth(options: Record<string, unknown>): Promise<{
    token: string;
    expiresAt: string;
  }>;
  request<T = unknown>(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<GitHubOctokitResponse<T>>;
  paginate<T = unknown>(route: string, parameters?: Record<string, unknown>): Promise<T[]>;
}

/** The response shape needed to classify an Octokit request failure. */
export interface GitHubOctokitResponse<T> {
  data: T;
  status?: number;
  headers?: Record<string, string | number | string[] | undefined>;
}

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Constructs the real Octokit App.
 *
 * This function is intentionally separate from `getGitHubApp`: callers such as
 * unit tests can supply a fully configured App without touching the process
 * environment, while the worker uses the lazy, memoized accessor below.
 */
export function createGitHubApp(config: GitHubAppConfig): GitHubAppHandle {
  const app = new App({
    appId: config.appId,
    privateKey: config.privateKey,
    // @octokit/app defaults to @octokit/core. The adapter needs paginate and
    // the generated REST endpoint surface, so the REST constructor is supplied
    // explicitly rather than relying on whichever default App ships with.
    Octokit,
    log: silentLog,
  }) as unknown as GitHubAppHandle;

  return app;
}

const globalForGitHub = globalThis as unknown as {
  __rivetGitHubApp?: GitHubAppHandle;
  __rivetGitHubAppId?: string;
};

let app: GitHubAppHandle | undefined;
let appId: string | undefined;

/**
 * Reads the App credentials only when a real GitHub client is requested.
 * Importing `@rivet/github` therefore remains safe during `next build`, tests,
 * and local runs that deliberately select `RIVET_GITHUB=off`.
 */
function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  const rawAppId = env.GITHUB_APP_ID?.trim();
  const encodedPrivateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();

  if (!rawAppId || !encodedPrivateKey) {
    throw new Error(
      "GitHub App credentials are not configured. Set GITHUB_APP_ID and " +
        "GITHUB_APP_PRIVATE_KEY before enabling the GitHub adapter.",
    );
  }

  const privateKey = Buffer.from(encodedPrivateKey, "base64").toString("utf8");
  if (!privateKey.trim()) {
    throw new Error("GITHUB_APP_PRIVATE_KEY did not contain a private key.");
  }

  return {
    appId: rawAppId,
    privateKey,
  };
}

/**
 * Returns the process-wide App, constructing it on first use.
 *
 * `@octokit/app` keeps its installation-token cache on the App's auth strategy.
 * Keeping one App instance is therefore important: constructing one per API
 * call would throw away that cache and turn every repository lookup into a new
 * token request. The App itself never makes a network request in its
 * constructor.
 */
export function getGitHubApp(config?: GitHubAppConfig): GitHubAppHandle {
  const resolved = config ?? configFromEnvironment();
  const resolvedAppId = String(resolved.appId);

  app ??= globalForGitHub.__rivetGitHubApp;
  appId ??= globalForGitHub.__rivetGitHubAppId;
  if (app && appId === resolvedAppId) return app;

  app = createGitHubApp(resolved);
  appId = resolvedAppId;
  if (process.env.NODE_ENV !== "production") {
    globalForGitHub.__rivetGitHubApp = app;
    globalForGitHub.__rivetGitHubAppId = appId;
  }
  return app;
}

/** Clears the lazy App. Tests and one-shot scripts use this between configs. */
export function resetGitHubApp(): void {
  app = undefined;
  appId = undefined;
  delete globalForGitHub.__rivetGitHubApp;
  delete globalForGitHub.__rivetGitHubAppId;
}

/** Exported for tests that need to validate the environment decoding itself. */
export function githubAppConfigFromEnvironment(env: NodeJS.ProcessEnv): GitHubAppConfig {
  return configFromEnvironment(env);
}
