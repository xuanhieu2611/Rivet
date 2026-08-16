/**
 * `@rivet/github` - the GitHub App adapter and its deterministic fake.
 *
 * `@rivet/core` owns the GitHub port. This package owns App authentication,
 * Octokit request mapping, bounded retries and test fixtures. Importing it does
 * not construct an App or read credentials; use `getGitHubApp` or
 * `createGitHubClient` when GitHub is actually enabled.
 */

export {
  createGitHubApp,
  getGitHubApp,
  githubAppConfigFromEnvironment,
  resetGitHubApp,
  type GitHubAppConfig,
  type GitHubAppHandle,
  type GitHubOctokit,
  type GitHubOctokitResponse,
} from "./app";
export {
  createGitHubClient,
  DEFAULT_GITHUB_RETRY_OPTIONS,
  getGitHubClient,
  GitHubInstallationToken,
  OctokitGitHubClient,
  resetGitHubClient,
  type GitHubClientOptions,
  type GitHubRetryOptions,
  type GitHubSleep,
} from "./github-client";
export {
  FakeGitHubClient,
  type FakeGitHubCall,
  type FakeGitHubFailure,
  type FakeGitHubMethod,
  type FakeGitHubOptions,
} from "./fake-github";
