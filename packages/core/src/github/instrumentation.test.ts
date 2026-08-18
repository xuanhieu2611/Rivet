import type { Installation, Issue, PullRequest, Repository } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  ATTR_GITHUB_INSTALLATION_ID,
  ATTR_GITHUB_OPERATION,
  ATTR_GITHUB_REPO,
  ATTR_GIT_OPERATION,
  SPAN_GITHUB_REQUEST,
  SPAN_HOST_GIT,
} from "../telemetry/attributes";
import { RecordingTelemetry } from "../telemetry/recording-telemetry";
import type { GitHubClient } from "./github";
import type { Publish, SeedClone } from "./host-git";
import { instrumentGitHubClient, instrumentPublish, instrumentSeedClone } from "./instrumentation";

const REPO = { owner: "acme", name: "widgets" };

function client(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listInstallations: () => Promise.resolve([] as Installation[]),
    listRepositories: () => Promise.resolve([] as Repository[]),
    listIssues: () => Promise.resolve([] as Issue[]),
    mintInstallationToken: () =>
      Promise.resolve({ value: "ghs_secret", expiresAt: new Date(), redact: () => "ghs_***" }),
    getRef: () => Promise.resolve(null),
    findPullRequest: () => Promise.resolve(null),
    createPullRequest: () => Promise.resolve({ number: 7 } as PullRequest),
    updatePullRequest: () => Promise.resolve({ number: 7 } as PullRequest),
    ...overrides,
  };
}

describe("instrumentGitHubClient", () => {
  it("opens one client span per call, naming the port method", async () => {
    const telemetry = new RecordingTelemetry();
    const wrapped = instrumentGitHubClient(client(), telemetry);

    await wrapped.listIssues(42, REPO);

    const [span] = telemetry.spansNamed(SPAN_GITHUB_REQUEST);
    expect(span?.kind).toBe("client");
    expect(span?.attributes[ATTR_GITHUB_OPERATION]).toBe("listIssues");
    expect(span?.attributes[ATTR_GITHUB_INSTALLATION_ID]).toBe(42);
    expect(span?.attributes[ATTR_GITHUB_REPO]).toBe("acme/widgets");
    expect(span?.ended).toBe(true);
  });

  it("records a failure on the span and rethrows it unchanged", async () => {
    const telemetry = new RecordingTelemetry();
    const failure = new Error("502 from GitHub");
    const wrapped = instrumentGitHubClient(
      client({ listInstallations: () => Promise.reject(failure) }),
      telemetry,
    );

    await expect(wrapped.listInstallations()).rejects.toBe(failure);

    const [span] = telemetry.spansNamed(SPAN_GITHUB_REQUEST);
    expect(span?.status).toBe("error");
    expect(span?.exceptions[0]?.error).toBe(failure);
    expect(span?.ended).toBe(true);
  });

  it("never puts a token on a span, which is the whole reason the attributes are thin", async () => {
    const telemetry = new RecordingTelemetry();
    const wrapped = instrumentGitHubClient(client(), telemetry);

    await wrapped.mintInstallationToken(42, REPO, "write");

    const [span] = telemetry.spansNamed(SPAN_GITHUB_REQUEST);
    expect(JSON.stringify(span?.attributes)).not.toContain("ghs_secret");
    // A positive control: the same search finds the scope, which is recorded.
    expect(JSON.stringify(span?.attributes)).toContain("write");
  });

  it("passes every result through untouched", async () => {
    const telemetry = new RecordingTelemetry();
    const wrapped = instrumentGitHubClient(client(), telemetry);

    await expect(
      wrapped.createPullRequest({ installationId: 1, repo: REPO } as never),
    ).resolves.toEqual({ number: 7 });
  });
});

describe("the host Git decorators", () => {
  it("times a seed clone and records the archive size", async () => {
    const telemetry = new RecordingTelemetry();
    const seedClone: SeedClone = () =>
      Promise.resolve({
        archive: new Uint8Array(9),
        commitSha: "a".repeat(40),
        treeSha: "b".repeat(40),
      });

    await instrumentSeedClone(seedClone, telemetry)({} as never);

    const [span] = telemetry.spansNamed(SPAN_HOST_GIT);
    expect(span?.attributes[ATTR_GIT_OPERATION]).toBe("seed_clone");
    expect(span?.attributes["rivet.git.archive_bytes"]).toBe(9);
  });

  it("records what a publish changed without recording where it pushed", async () => {
    const telemetry = new RecordingTelemetry();
    const publish: Publish = () =>
      Promise.resolve({
        filesChanged: 3,
        insertions: 10,
        deletions: 2,
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        forced: false,
      });

    await instrumentPublish(
      publish,
      telemetry,
    )({
      remoteUrl: "https://x-access-token:ghs_secret@github.com/acme/widgets.git",
    } as never);

    const [span] = telemetry.spansNamed(SPAN_HOST_GIT);
    expect(span?.attributes[ATTR_GIT_OPERATION]).toBe("publish");
    expect(span?.attributes["rivet.git.files_changed"]).toBe(3);
    expect(JSON.stringify(span?.attributes)).not.toContain("ghs_secret");
  });
});
