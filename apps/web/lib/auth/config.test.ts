import { describe, expect, it } from "vitest";

import { assertWebAuthModeAllowed, resolveWebAuthConfig } from "./config";

describe("web auth configuration", () => {
  it("defaults to an open local control plane", () => {
    expect(resolveWebAuthConfig({})).toEqual({ mode: "off" });
  });

  it("requires all GitHub identifying-flow credentials", () => {
    expect(resolveWebAuthConfig({ RIVET_AUTH: "github" })).toEqual({
      mode: "github",
      enabled: false,
      reason: "unconfigured",
    });
  });

  it("keeps OAuth credentials separate from the App private key", () => {
    expect(
      resolveWebAuthConfig({
        RIVET_AUTH: "github",
        GITHUB_APP_CLIENT_ID: "Iv1.test",
        GITHUB_APP_CLIENT_SECRET: "secret",
        RIVET_OWNER_GITHUB_LOGIN: "owner",
        RIVET_SESSION_SECRET: "a sufficiently long session secret",
        GITHUB_APP_PRIVATE_KEY: "must not be read",
      }),
    ).toMatchObject({ mode: "github", enabled: true, clientId: "Iv1.test" });
  });

  it("refuses auth off in production", () => {
    expect(() => assertWebAuthModeAllowed("off", "production")).toThrow(/RIVET_AUTH=off/);
    expect(() => assertWebAuthModeAllowed("github", "production")).not.toThrow();
  });
});
