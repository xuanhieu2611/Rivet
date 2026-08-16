import { describe, expect, it } from "vitest";

import { installationUrl, manageInstallationUrl, resolveGitHubWebConfig } from "./config";

describe("resolveGitHubWebConfig", () => {
  it("defaults to disabled, so a machine with no configuration still renders", () => {
    expect(resolveGitHubWebConfig({})).toEqual({ enabled: false, reason: "disabled" });
  });

  it("treats any mode other than app as off", () => {
    expect(resolveGitHubWebConfig({ RIVET_GITHUB: "off" }).enabled).toBe(false);
    expect(resolveGitHubWebConfig({ RIVET_GITHUB: "  " }).enabled).toBe(false);
  });

  it("reports missing credentials separately from being turned off", () => {
    // The two are different problems with different fixes, and collapsing them
    // would send somebody to change an env switch that is already correct.
    expect(resolveGitHubWebConfig({ RIVET_GITHUB: "app" })).toEqual({
      enabled: false,
      reason: "unconfigured",
    });
    expect(resolveGitHubWebConfig({ RIVET_GITHUB: "app", GITHUB_APP_ID: "1" })).toEqual({
      enabled: false,
      reason: "unconfigured",
    });
  });

  it("enables the surface once the App id and private key are both present", () => {
    expect(
      resolveGitHubWebConfig({
        RIVET_GITHUB: "app",
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "base64",
        GITHUB_APP_SLUG: "rivet-dev",
      }),
    ).toEqual({ enabled: true, appSlug: "rivet-dev" });
  });

  it("enables without a slug, which only costs the install link", () => {
    expect(
      resolveGitHubWebConfig({
        RIVET_GITHUB: "app",
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "base64",
      }),
    ).toEqual({ enabled: true, appSlug: null });
  });
});

describe("installation urls", () => {
  it("builds an install link only when the slug is known", () => {
    expect(installationUrl("rivet-dev")).toBe(
      "https://github.com/apps/rivet-dev/installations/new",
    );
    expect(installationUrl(null)).toBeNull();
  });

  it("addresses an existing installation by its GitHub id", () => {
    expect(manageInstallationUrl(42)).toBe("https://github.com/settings/installations/42");
  });
});
