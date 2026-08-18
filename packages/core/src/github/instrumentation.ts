/**
 * GitHub and host Git operations, wrapped in spans.
 *
 * Decorators rather than instrumentation inside the adapters, for the reason
 * every other boundary in this system is a port: `apps/worker/src/github.ts`
 * assembles Octokit and the two host Git functions, and adding a `withSpan`
 * around each of eight methods there would put OpenTelemetry-shaped code in the
 * one file whose job is to keep credentials out of core. Here the wrapping is
 * one function over an interface, and it is testable against `FakeGitHubClient`
 * with `RecordingTelemetry` and no network at all.
 *
 * These are `client` spans, because every one of them is a call this process
 * makes to something else. The attributes are deliberately thin: an
 * installation id, a repository, and the port method's own name. A token never
 * appears, an issue body never appears, and a branch name never appears - a
 * span is an export to a third-party backend, so it gets the same treatment
 * `SecretRegistry` gives a log line, one system further out.
 */

import {
  ATTR_GITHUB_INSTALLATION_ID,
  ATTR_GITHUB_OPERATION,
  ATTR_GITHUB_REPO,
  ATTR_GIT_OPERATION,
  SPAN_GITHUB_REQUEST,
  SPAN_HOST_GIT,
} from "../telemetry/attributes";
import type { Attributes, Telemetry } from "../telemetry/telemetry";
import type { RepoRef } from "@rivet/contracts";

import type { GitHubClient } from "./github";
import type { GitHubPipelineOptions, Publish, SeedClone } from "./host-git";

/** `owner/name`, the only repository identity a span carries. */
function repoAttribute(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

function request<T>(
  telemetry: Telemetry,
  operation: string,
  attributes: Attributes,
  body: () => Promise<T>,
): Promise<T> {
  return telemetry.withSpan(
    SPAN_GITHUB_REQUEST,
    { kind: "client", attributes: { [ATTR_GITHUB_OPERATION]: operation, ...attributes } },
    body,
  );
}

/**
 * Every port method, in a span.
 *
 * Written out method by method rather than through a `Proxy`, and the tedium is
 * the point: a `Proxy` would silently instrument a method added in a later
 * milestone with no attributes and a name derived from whatever it was called,
 * whereas this fails `pnpm typecheck` until somebody decides what the new
 * operation should record. That is the same argument
 * `EVALUATION_FAILURE_CLASSES` makes as a total `Record`.
 */
export function instrumentGitHubClient(client: GitHubClient, telemetry: Telemetry): GitHubClient {
  return {
    listInstallations: () =>
      request(telemetry, "listInstallations", {}, () => client.listInstallations()),

    listRepositories: (installationId) =>
      request(
        telemetry,
        "listRepositories",
        { [ATTR_GITHUB_INSTALLATION_ID]: installationId },
        () => client.listRepositories(installationId),
      ),

    listIssues: (installationId, repo) =>
      request(
        telemetry,
        "listIssues",
        {
          [ATTR_GITHUB_INSTALLATION_ID]: installationId,
          [ATTR_GITHUB_REPO]: repoAttribute(repo),
        },
        () => client.listIssues(installationId, repo),
      ),

    mintInstallationToken: (installationId, repo, scope) =>
      request(
        telemetry,
        "mintInstallationToken",
        {
          [ATTR_GITHUB_INSTALLATION_ID]: installationId,
          [ATTR_GITHUB_REPO]: repoAttribute(repo),
          // The scope, not the token. Which half of the permission set was
          // asked for is the useful fact and carries nothing secret.
          "rivet.github.token_scope": scope,
        },
        () => client.mintInstallationToken(installationId, repo, scope),
      ),

    getRef: (installationId, repo, ref) =>
      request(
        telemetry,
        "getRef",
        {
          [ATTR_GITHUB_INSTALLATION_ID]: installationId,
          [ATTR_GITHUB_REPO]: repoAttribute(repo),
          "rivet.github.ref": ref,
        },
        () => client.getRef(installationId, repo, ref),
      ),

    findPullRequest: (installationId, repo, head) =>
      request(
        telemetry,
        "findPullRequest",
        {
          [ATTR_GITHUB_INSTALLATION_ID]: installationId,
          [ATTR_GITHUB_REPO]: repoAttribute(repo),
          "rivet.github.head": head,
        },
        () => client.findPullRequest(installationId, repo, head),
      ),

    createPullRequest: (input) =>
      request(
        telemetry,
        "createPullRequest",
        {
          [ATTR_GITHUB_INSTALLATION_ID]: input.installationId,
          [ATTR_GITHUB_REPO]: repoAttribute(input.repo),
        },
        () => client.createPullRequest(input),
      ),

    updatePullRequest: (input) =>
      request(
        telemetry,
        "updatePullRequest",
        {
          [ATTR_GITHUB_INSTALLATION_ID]: input.installationId,
          [ATTR_GITHUB_REPO]: repoAttribute(input.repo),
          "rivet.github.pull_request_number": input.number,
        },
        () => client.updatePullRequest(input),
      ),
  };
}

/**
 * The two host Git operations, in spans.
 *
 * These are the slowest things a job does outside the container - a clone and
 * an archive of somebody else's repository, and a clone, apply, commit and push
 * of the result - and until now the only evidence of how long they took was the
 * gap between two events. Neither records the remote URL, which carries the
 * repository identity the job row already holds and, on the publish path, sits
 * one mistake away from carrying a token.
 */
export function instrumentSeedClone(seedClone: SeedClone, telemetry: Telemetry): SeedClone {
  return (input) =>
    telemetry.withSpan(
      SPAN_HOST_GIT,
      { kind: "client", attributes: { [ATTR_GIT_OPERATION]: "seed_clone" } },
      async (span) => {
        const result = await seedClone(input);
        span.setAttributes({ "rivet.git.archive_bytes": result.archive.byteLength });
        return result;
      },
    );
}

export function instrumentPublish(publish: Publish, telemetry: Telemetry): Publish {
  return (input) =>
    telemetry.withSpan(
      SPAN_HOST_GIT,
      { kind: "client", attributes: { [ATTR_GIT_OPERATION]: "publish" } },
      async (span) => {
        const result = await publish(input);
        span.setAttributes({
          "rivet.git.files_changed": result.filesChanged,
          "rivet.git.forced": result.forced,
        });
        return result;
      },
    );
}

/**
 * All three at once, which is how the worker actually holds them.
 *
 * One call site rather than three, so a future fourth operation cannot be
 * instrumented in two of the three places that assemble these.
 */
export function instrumentGitHubOptions(
  options: GitHubPipelineOptions,
  telemetry: Telemetry,
): GitHubPipelineOptions {
  return {
    ...options,
    client: instrumentGitHubClient(options.client, telemetry),
    seedClone: instrumentSeedClone(options.seedClone, telemetry),
    publish: instrumentPublish(options.publish, telemetry),
  };
}
