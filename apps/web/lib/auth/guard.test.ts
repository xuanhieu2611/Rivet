import { afterEach, describe, expect, it, vi } from "vitest";

import { requireSession } from "./guard";

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

  it("refuses auth off in production", async () => {
    vi.stubEnv("RIVET_AUTH", "off");
    vi.stubEnv("NODE_ENV", "production");
    await expect(requireSession(new Request("http://localhost/api/jobs"))).rejects.toThrow(
      /RIVET_AUTH=off/,
    );
  });
});
