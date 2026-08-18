import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

vi.mock("server-only", () => ({}));

const ENV = {
  RIVET_AUTH: "github",
  GITHUB_APP_CLIENT_ID: "Iv1.test",
  GITHUB_APP_CLIENT_SECRET: "oauth-secret",
  RIVET_OWNER_GITHUB_LOGIN: "owner",
  RIVET_SESSION_SECRET: "a sufficiently long test session secret",
  NODE_ENV: "test",
};

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
});

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/auth/signin", () => {
  it("redirects to GitHub and stores a one-time state cookie", async () => {
    const response = await GET(new Request("http://localhost/api/auth/signin"));
    const location = new URL(response.headers.get("location") ?? "");

    expect(response.status).toBe(303);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("Iv1.test");
    expect(location.searchParams.get("scope")).toBe("read:user");
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(response.headers.get("set-cookie")).toContain("rivet_oauth_state=");
  });

  it("redirects home when authentication is explicitly off", async () => {
    vi.stubEnv("RIVET_AUTH", "off");
    const response = await GET(new Request("http://localhost/api/auth/signin"));
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/");
  });
});
