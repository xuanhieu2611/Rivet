import type { Installation } from "@rivet/contracts";
import { GitHubPermissionDeniedError, GitHubUnavailableError } from "@rivet/core";
import { syncGitHubInstallations } from "@rivet/core";
import type * as RivetCoreModule from "@rivet/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GitHubClientModule from "@/lib/github/client";
import { githubAccess } from "@/lib/github/client";

import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/github/client", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubClientModule>();
  return { ...actual, githubAccess: vi.fn() };
});
vi.mock("@rivet/core", async (importOriginal) => {
  const actual = await importOriginal<typeof RivetCoreModule>();
  return { ...actual, syncGitHubInstallations: vi.fn() };
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
const sync = vi.mocked(syncGitHubInstallations);

function enabled() {
  access.mockReturnValue({ enabled: true, client: {} as never });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/**
 * The route's own request, which the handler ignores and `withRoute` does not:
 * every handler is now wrapped in a request span and a per-request logger, and
 * both are built from this.
 */
function request(): Request {
  return new Request("http://localhost/api/github/installations");
}

describe("GET /api/github/installations", () => {
  it("returns what the provider reports, refreshed into Postgres", async () => {
    enabled();
    sync.mockResolvedValue([INSTALLATION]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ installations: [INSTALLATION] });
  });

  it("answers 503 when GitHub is off here, so the client shows the manual field", async () => {
    access.mockReturnValue({ enabled: false, reason: "disabled" });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(sync).not.toHaveBeenCalled();
  });

  it("distinguishes a permission denial from an outage", async () => {
    enabled();
    sync.mockRejectedValue(new GitHubPermissionDeniedError("uninstalled"));
    expect((await GET(request())).status).toBe(403);

    sync.mockRejectedValue(new GitHubUnavailableError("502 from GitHub"));
    expect((await GET(request())).status).toBe(502);
  });

  it("does not dress an ordinary bug up as a GitHub problem", async () => {
    enabled();
    sync.mockRejectedValue(new Error("column does not exist"));

    const response = await GET(request());

    expect(response.status).toBe(500);
    // The real cause is logged, never returned: it carries table and column names.
    expect(await response.json()).toEqual({ error: "Something went wrong. Please try again." });
  });
});
