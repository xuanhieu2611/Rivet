import type { Repository } from "@rivet/contracts";
import { GitHubPermissionDeniedError } from "@rivet/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GitHubClientModule from "@/lib/github/client";
import { githubAccess } from "@/lib/github/client";

import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/github/client", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubClientModule>();
  return { ...actual, githubAccess: vi.fn() };
});

const REPOSITORY: Repository = {
  id: 7,
  owner: "acme",
  name: "widgets",
  private: true,
  defaultBranch: "main",
};

const access = vi.mocked(githubAccess);
const listRepositories = vi.fn();

function enabled() {
  access.mockReturnValue({ enabled: true, client: { listRepositories } as never });
}

function request(query: string) {
  return new Request(`http://localhost/api/github/repositories${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/github/repositories", () => {
  it("lists what the installation reaches", async () => {
    enabled();
    listRepositories.mockResolvedValue([REPOSITORY]);

    const response = await GET(request("?installationId=42"));

    expect(listRepositories).toHaveBeenCalledWith(42);
    expect(await response.json()).toEqual({ repositories: [REPOSITORY] });
  });

  it("rejects a missing or malformed installation id before calling GitHub", async () => {
    enabled();

    for (const query of ["", "?installationId=", "?installationId=abc", "?installationId=-1"]) {
      expect((await GET(request(query))).status).toBe(400);
    }
    expect(listRepositories).not.toHaveBeenCalled();
  });

  it("answers 503 when GitHub is unavailable on this deployment", async () => {
    access.mockReturnValue({ enabled: false, reason: "unconfigured" });
    expect((await GET(request("?installationId=42"))).status).toBe(503);
  });

  it("maps a permission denial to 403", async () => {
    enabled();
    listRepositories.mockRejectedValue(new GitHubPermissionDeniedError("404 on the installation"));
    expect((await GET(request("?installationId=42"))).status).toBe(403);
  });
});
