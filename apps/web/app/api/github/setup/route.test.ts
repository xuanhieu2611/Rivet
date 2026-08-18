import type { Installation } from "@rivet/contracts";
import { syncGitHubInstallation } from "@rivet/core";
import type * as RivetCoreModule from "@rivet/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GitHubClientModule from "@/lib/github/client";
import { githubAccess } from "@/lib/github/client";

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
vi.mock("@/lib/github/client", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubClientModule>();
  return { ...actual, githubAccess: vi.fn() };
});
vi.mock("@rivet/core", async (importOriginal) => {
  const actual = await importOriginal<typeof RivetCoreModule>();
  return { ...actual, syncGitHubInstallation: vi.fn() };
});

const INSTALLATION: Installation = {
  id: 42,
  accountLogin: "acme",
  accountType: "Organization",
  targetType: "Organization",
  permissions: { contents: "write" },
  suspended: false,
};

const access = vi.mocked(githubAccess);
const sync = vi.mocked(syncGitHubInstallation);

function request(query: string) {
  return new Request(`http://localhost/api/github/setup${query}`);
}

function locationOf(response: Response): string {
  return (
    new URL(response.headers.get("location") ?? "").pathname +
    new URL(response.headers.get("location") ?? "").search
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  access.mockReturnValue({ enabled: true, client: {} as never });
});

describe("GET /api/github/setup", () => {
  it("records the installation and sends the browser to the settings page", async () => {
    sync.mockResolvedValue(INSTALLATION);

    const response = await GET(request("?installation_id=42&setup_action=install"));

    expect(sync).toHaveBeenCalledWith(expect.anything(), 42);
    expect(response.status).toBe(303);
    expect(locationOf(response)).toBe("/settings/github?setup=installed");
  });

  it("records nothing for an installation this App cannot act on", async () => {
    // The callback's id is a query parameter on an unauthenticated route. The
    // App's own installation list is the check that keeps a hand-typed URL from
    // fabricating a publication target.
    sync.mockResolvedValue(null);

    expect(locationOf(await GET(request("?installation_id=999")))).toBe(
      "/settings/github?setup=unknown",
    );
  });

  it("reports a pending organization approval rather than looking up nothing", async () => {
    expect(locationOf(await GET(request("?installation_id=42&setup_action=request")))).toBe(
      "/settings/github?setup=requested",
    );
    expect(sync).not.toHaveBeenCalled();
  });

  it("reports a callback with no usable installation id", async () => {
    expect(locationOf(await GET(request("")))).toBe("/settings/github?setup=invalid");
    expect(locationOf(await GET(request("?installation_id=abc")))).toBe(
      "/settings/github?setup=invalid",
    );
  });

  it("redirects rather than 500s when GitHub cannot be reached", async () => {
    sync.mockRejectedValue(new Error("socket hang up"));

    const response = await GET(request("?installation_id=42"));

    expect(response.status).toBe(303);
    expect(locationOf(response)).toBe("/settings/github?setup=failed");
  });

  it("answers 503 when GitHub is off on this deployment", async () => {
    access.mockReturnValue({ enabled: false, reason: "disabled" });
    expect((await GET(request("?installation_id=42"))).status).toBe(503);
  });
});
