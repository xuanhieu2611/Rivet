import { describe, expect, it } from "vitest";

import { AgentPathError, resolveInside } from "./paths";

/**
 * The containment tests, and they are the ones to keep honest.
 *
 * Every case here is a string a model could plausibly produce - a relative
 * path, a parent traversal, an absolute path into somewhere interesting, a home
 * directory the harness already expanded on the host - and the question in each
 * is the same: does the answer stay inside the repository. A regression here
 * would not look like a test failure in any other file.
 */

const REPO = "/home/node/workspace/repo";

describe("resolveInside", () => {
  it("resolves a relative path against the repository", () => {
    expect(resolveInside(REPO, "src/index.ts")).toBe(`${REPO}/src/index.ts`);
    expect(resolveInside(REPO, "./package.json")).toBe(`${REPO}/package.json`);
  });

  it("accepts an absolute path that is already inside", () => {
    expect(resolveInside(REPO, `${REPO}/src/a.ts`)).toBe(`${REPO}/src/a.ts`);
  });

  it("normalises before deciding, so an interior traversal is fine", () => {
    expect(resolveInside(REPO, "src/../lib/b.ts")).toBe(`${REPO}/lib/b.ts`);
  });

  it("accepts the repository root itself", () => {
    expect(resolveInside(REPO, ".")).toBe(REPO);
  });

  it("rejects a traversal that escapes", () => {
    expect(() => resolveInside(REPO, "../secrets.txt")).toThrow(AgentPathError);
    expect(() => resolveInside(REPO, "src/../../../etc/passwd")).toThrow(AgentPathError);
  });

  it("rejects an absolute path outside", () => {
    expect(() => resolveInside(REPO, "/etc/passwd")).toThrow(AgentPathError);
    // What a harness-expanded `~/.ssh/id_rsa` looks like by the time it arrives.
    expect(() => resolveInside(REPO, "/Users/someone/.ssh/id_rsa")).toThrow(AgentPathError);
  });

  it("does not mistake a sibling with a shared prefix for a child", () => {
    expect(() => resolveInside(REPO, "/home/node/workspace/repo-backup/x")).toThrow(AgentPathError);
  });

  it("names the path the model wrote, so the model can correct it", () => {
    try {
      resolveInside(REPO, "../../../etc/shadow");
      expect.unreachable("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentPathError);
      expect((error as AgentPathError).path).toBe("../../../etc/shadow");
      expect((error as Error).message).toContain("outside the repository");
    }
  });
});
