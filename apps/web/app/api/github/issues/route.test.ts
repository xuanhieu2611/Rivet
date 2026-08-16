import type { Issue } from "@rivet/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GitHubClientModule from "@/lib/github/client";
import { githubAccess } from "@/lib/github/client";

import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/github/client", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubClientModule>();
  return { ...actual, githubAccess: vi.fn() };
});

const ISSUE: Issue = {
  number: 9,
  title: "Health check returns 500",
  body: "It should return the build SHA.",
  htmlUrl: "https://github.com/acme/widgets/issues/9",
  state: "open",
};

const access = vi.mocked(githubAccess);
const listIssues = vi.fn();

function enabled() {
  access.mockReturnValue({ enabled: true, client: { listIssues } as never });
}

function request(query: string) {
  return new Request(`http://localhost/api/github/issues${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/github/issues", () => {
  it("lists a repository's issues", async () => {
    enabled();
    listIssues.mockResolvedValue([ISSUE]);

    const response = await GET(request("?installationId=42&owner=acme&name=widgets"));

    expect(listIssues).toHaveBeenCalledWith(42, { owner: "acme", name: "widgets" });
    expect(await response.json()).toEqual({ issues: [ISSUE] });
  });

  it("requires the repository as well as the installation", async () => {
    enabled();

    for (const query of [
      "?installationId=42",
      "?installationId=42&owner=acme",
      "?installationId=42&name=widgets",
      "?owner=acme&name=widgets",
    ]) {
      expect((await GET(request(query))).status).toBe(400);
    }
    expect(listIssues).not.toHaveBeenCalled();
  });
});
