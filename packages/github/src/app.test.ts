import { describe, expect, it, afterEach } from "vitest";

import { getGitHubApp, githubAppConfigFromEnvironment, resetGitHubApp } from "./app";

afterEach(() => {
  resetGitHubApp();
});

describe("GitHub App construction", () => {
  it("decodes the base64 private key only when configuration is requested", () => {
    const config = githubAppConfigFromEnvironment({
      GITHUB_APP_ID: "42",
      GITHUB_APP_PRIVATE_KEY: Buffer.from("private-key").toString("base64"),
    });

    expect(config).toEqual({ appId: "42", privateKey: "private-key" });
  });

  it("memoizes one App so Octokit's installation-token cache survives calls", () => {
    const config = {
      appId: 42,
      privateKey: "-----BEGIN PRIVATE KEY-----\nnot-used-in-this-test\n-----END PRIVATE KEY-----",
    };

    const first = getGitHubApp(config);
    const second = getGitHubApp(config);

    expect(second).toBe(first);
  });

  it("does not silently accept missing credentials when enabled", () => {
    expect(() => githubAppConfigFromEnvironment({})).toThrow(/GITHUB_APP_ID/);
  });
});
