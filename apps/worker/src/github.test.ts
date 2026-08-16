import { FakeGitHubClient } from "@rivet/github";
import { describe, expect, it } from "vitest";

import type { GitHubConfig } from "./config";
import { createGitHubOptions, withTokenRegistration } from "./github";
import { publish, seedClone } from "./git";
import { REDACTED, SecretRegistry } from "./secrets";

const SENTINEL = "ghs_sentineltokenvalue0123456789";

const APP_CONFIG: GitHubConfig = {
  mode: "app",
  cloneTimeoutMs: 60_000,
  pushTimeoutMs: 90_000,
  seedMaxBytes: 2_097_152,
  appId: "123456",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n",
};

describe("createGitHubOptions", () => {
  it("supplies nothing at all when GitHub is off", () => {
    // `PipelineOptions.github` absent is what keeps the in-container clone path
    // and `publication.skipped` in place for CI and every existing suite.
    expect(
      createGitHubOptions({ ...APP_CONFIG, mode: "off" }, new SecretRegistry()),
    ).toBeUndefined();
  });

  it("hands core the host Git operations and the bounds they run under", () => {
    const options = createGitHubOptions(APP_CONFIG, new SecretRegistry());

    expect(options).toBeDefined();
    // The real functions, not wrappers: this is the only place in the system
    // that runs `git` on the host, and core is told rather than asked.
    expect(options?.seedClone).toBe(seedClone);
    expect(options?.publish).toBe(publish);
    expect(options?.cloneTimeoutMs).toBe(60_000);
    expect(options?.pushTimeoutMs).toBe(90_000);
    expect(options?.seedMaxBytes).toBe(2_097_152);
  });
});

describe("withTokenRegistration", () => {
  it("registers a minted token before it reaches its caller", async () => {
    const secrets = new SecretRegistry();
    const client = withTokenRegistration(new FakeGitHubClient({ tokenValue: SENTINEL }), secrets);

    const token = await client.mintInstallationToken(
      42,
      { owner: "acme", name: "widgets" },
      "write",
    );

    expect(token.value).toBe(SENTINEL);
    // The window this closes: a live credential existing while the redaction
    // pass does not know about it.
    expect(secrets.redact(`pushing with ${token.value}`)).toBe(`pushing with ${REDACTED}`);
  });

  it("passes every other call through unchanged", async () => {
    const fake = new FakeGitHubClient({
      repositories: [
        {
          id: 1,
          owner: "acme",
          name: "widgets",
          private: false,
          defaultBranch: "main",
        },
      ],
    });
    const client = withTokenRegistration(fake, new SecretRegistry());

    await expect(client.listRepositories(42)).resolves.toHaveLength(1);
    expect(fake.calls.map((call) => call.method)).toEqual(["listRepositories"]);
  });
});
