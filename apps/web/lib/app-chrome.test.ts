import { describe, expect, it } from "vitest";

import { resolveAppChrome } from "./app-chrome";

describe("resolveAppChrome", () => {
  it("answers with defaults on a machine that configures nothing", () => {
    // `next build` runs here, so an empty env must still produce a footer.
    const chrome = resolveAppChrome({});

    expect(chrome.version).toBe("0.0.0-dev");
    expect(chrome.repoUrl).toMatch(/^https:\/\/github\.com\//);
    expect(chrome.docsUrl).toBe(`${chrome.repoUrl}/tree/main/docs`);
  });

  it("reports the same version telemetry stamps on a span", () => {
    expect(resolveAppChrome({ RIVET_SERVICE_VERSION: "abc1234" }).version).toBe("abc1234");
  });

  it("derives the docs link from a custom repository", () => {
    const chrome = resolveAppChrome({ RIVET_REPO_URL: "https://github.com/acme/widgets" });

    expect(chrome.repoUrl).toBe("https://github.com/acme/widgets");
    expect(chrome.docsUrl).toBe("https://github.com/acme/widgets/tree/main/docs");
  });

  it("lets an explicit docs site win over the derived one", () => {
    expect(resolveAppChrome({ RIVET_DOCS_URL: "https://docs.example.com" }).docsUrl).toBe(
      "https://docs.example.com",
    );
  });

  it("treats blank as absent rather than as a value", () => {
    expect(resolveAppChrome({ RIVET_SERVICE_VERSION: "   " }).version).toBe("0.0.0-dev");
  });
});
