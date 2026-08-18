import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticatedPrincipal, requireSession } from "./guard";
import { createSessionToken, SESSION_COOKIE } from "./session";

const SECRET = "a sufficiently long test session secret";

function githubMode(owner: string): void {
  vi.stubEnv("RIVET_AUTH", "github");
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "oauth-secret");
  vi.stubEnv("RIVET_OWNER_GITHUB_LOGIN", owner);
  vi.stubEnv("RIVET_SESSION_SECRET", SECRET);
  vi.stubEnv("NODE_ENV", "test");
}

async function signedRequest(login: string): Promise<Request> {
  const token = await createSessionToken(login, SECRET);
  return new Request("http://localhost/api/jobs", {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("API session guard", () => {
  it("allows local mode without a cookie", async () => {
    vi.stubEnv("RIVET_AUTH", "off");
    vi.stubEnv("NODE_ENV", "test");
    await expect(requireSession(new Request("http://localhost/api/jobs"))).resolves.toBeNull();
  });

  it("rejects GitHub mode without a valid signed session", async () => {
    vi.stubEnv("RIVET_AUTH", "github");
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "oauth-secret");
    vi.stubEnv("RIVET_OWNER_GITHUB_LOGIN", "owner");
    vi.stubEnv("RIVET_SESSION_SECRET", "a sufficiently long test session secret");
    vi.stubEnv("NODE_ENV", "test");

    const response = await requireSession(new Request("http://localhost/api/jobs"));
    expect(response?.status).toBe(401);
  });

  it("accepts a signed session for the configured owner", async () => {
    githubMode("owner");
    await expect(requireSession(await signedRequest("Owner"))).resolves.toBeNull();
    await expect(authenticatedPrincipal(await signedRequest("Owner"))).resolves.toBe("owner");
  });

  it("refuses a validly signed session for a login that is no longer the owner", async () => {
    // The callback checked the allowlist a week ago; the allowlist has moved on
    // and there is no session table to revoke the old cookie from.
    githubMode("new-owner");
    const request = await signedRequest("previous-owner");

    expect((await requireSession(request))?.status).toBe(401);
    await expect(authenticatedPrincipal(await signedRequest("previous-owner"))).resolves.toBeNull();
  });

  it("refuses auth off in production", async () => {
    vi.stubEnv("RIVET_AUTH", "off");
    vi.stubEnv("NODE_ENV", "production");
    await expect(requireSession(new Request("http://localhost/api/jobs"))).rejects.toThrow(
      /RIVET_AUTH=off/,
    );
  });
});
