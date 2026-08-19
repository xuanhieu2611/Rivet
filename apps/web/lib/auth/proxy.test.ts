import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_PAGES } from "./public-pages";
import { proxy } from "../../proxy";

function githubMode(): void {
  vi.stubEnv("RIVET_AUTH", "github");
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "oauth-secret");
  vi.stubEnv("RIVET_OWNER_GITHUB_LOGIN", "owner");
  vi.stubEnv("RIVET_SESSION_SECRET", "a sufficiently long test session secret");
  vi.stubEnv("NODE_ENV", "test");
}

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost"), {
    headers: cookie ? { cookie } : {},
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("page proxy", () => {
  it("lets every public page through without a session", () => {
    githubMode();
    expect([...PUBLIC_PAGES].sort()).toEqual(["/", "/sign-in"]);

    for (const path of PUBLIC_PAGES) {
      const response = proxy(request(path));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("location"), path).toBeNull();
    }
  });

  it("redirects an unauthenticated visitor away from /jobs", () => {
    githubMode();
    const response = proxy(request("/jobs"));
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    const location = new URL(response.headers.get("location") ?? "", "http://localhost");
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("next")).toBe("/jobs");
  });

  it("does not redirect when authentication is off", () => {
    vi.stubEnv("RIVET_AUTH", "off");
    vi.stubEnv("NODE_ENV", "test");
    const response = proxy(request("/jobs"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
