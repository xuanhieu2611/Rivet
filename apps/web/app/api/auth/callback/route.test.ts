import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@rivet/queue", () => ({
  getRateLimiter: () => ({
    consume: vi
      .fn()
      .mockResolvedValue({ allowed: true, resetAt: Date.now() + 600_000, remaining: 9 }),
  }),
  RateLimitUnavailableError: class RateLimitUnavailableError extends Error {},
}));

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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/auth/callback", () => {
  it("identifies the configured owner without persisting the OAuth token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "temporary-token" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: "Owner" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request("http://localhost/api/auth/callback?state=state&code=code", {
        headers: { Cookie: "rivet_oauth_state=state" },
      }),
    );

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/jobs");
    expect(response.headers.get("set-cookie")).toContain("rivet_session=");
    expect(response.headers.get("set-cookie")).not.toContain("temporary-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.github.com/user");
  });

  it("rejects a GitHub account other than the configured owner", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "temporary-token" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: "intruder" })));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request("http://localhost/api/auth/callback?state=state&code=code", {
        headers: { Cookie: "rivet_oauth_state=state" },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).not.toContain("rivet_session=");
  });

  it("rejects a callback without the matching state", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request("http://localhost/api/auth/callback?state=wrong&code=code", {
        headers: { Cookie: "rivet_oauth_state=expected" },
      }),
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
