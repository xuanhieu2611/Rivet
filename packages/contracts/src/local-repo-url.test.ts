import { describe, expect, it } from "vitest";

import { createJobSchema } from "./job";
import {
  formatLocalRepoUrl,
  isLocalRepoUrl,
  LOCAL_REPO_URL_SCHEME,
  localRepoUrlSchema,
  parseLocalRepoUrl,
} from "./local-repo-url";

describe("parseLocalRepoUrl", () => {
  it("reads a case id out of the scheme", () => {
    expect(parseLocalRepoUrl("rivet-local:fixture-pass")).toBe("fixture-pass");
    expect(parseLocalRepoUrl("rivet-local:bulk-discount-boundary")).toBe("bulk-discount-boundary");
  });

  it("returns null for anything that is not this scheme", () => {
    expect(parseLocalRepoUrl("https://github.com/rivet/rivet")).toBeNull();
    expect(parseLocalRepoUrl("file:///tmp/x")).toBeNull();
    expect(parseLocalRepoUrl("file:///etc/passwd")).toBeNull();
    expect(parseLocalRepoUrl("git://localhost/x.git")).toBeNull();
    expect(parseLocalRepoUrl("")).toBeNull();
  });

  // The whole reason the scheme is opaque: none of these can name a path,
  // because none of them is a valid benchmark id.
  it("refuses every attempt to carry a path", () => {
    expect(parseLocalRepoUrl("rivet-local:../../etc")).toBeNull();
    expect(parseLocalRepoUrl("rivet-local:/etc/passwd")).toBeNull();
    expect(parseLocalRepoUrl("rivet-local:a/../../b")).toBeNull();
    expect(parseLocalRepoUrl("rivet-local:fixture-pass/../other")).toBeNull();
    expect(parseLocalRepoUrl("rivet-local://host/case")).toBeNull();
    expect(parseLocalRepoUrl("rivet-local:.")).toBeNull();
    expect(parseLocalRepoUrl("rivet-local:")).toBeNull();
    expect(parseLocalRepoUrl("rivet-local:Fixture-Pass")).toBeNull();
    expect(parseLocalRepoUrl("rivet-local:fixture pass")).toBeNull();
    expect(parseLocalRepoUrl("rivet-local:fixture-pass\n../escape")).toBeNull();
  });

  it("recognises the scheme even when the id is malformed", () => {
    // `isLocalRepoUrl` answers "which path should refuse this", and a malformed
    // id must be refused as a broken local URL rather than clone-attempted.
    expect(isLocalRepoUrl("rivet-local:../../etc")).toBe(true);
    expect(isLocalRepoUrl("https://github.com/rivet/rivet")).toBe(false);
  });
});

describe("localRepoUrlSchema", () => {
  it("accepts a well-formed local URL and rejects the rest", () => {
    expect(localRepoUrlSchema.parse("rivet-local:fixture-pass")).toBe("rivet-local:fixture-pass");
    expect(localRepoUrlSchema.safeParse("rivet-local:../x").success).toBe(false);
    expect(localRepoUrlSchema.safeParse("https://example.com/repo").success).toBe(false);
  });
});

describe("formatLocalRepoUrl", () => {
  it("builds the URL a runner stores on a job row", () => {
    expect(formatLocalRepoUrl("fixture-pass")).toBe(`${LOCAL_REPO_URL_SCHEME}fixture-pass`);
  });

  it("throws rather than emitting an id it could not validate", () => {
    expect(() => formatLocalRepoUrl("../escape")).toThrow();
  });
});

describe("createJobSchema", () => {
  // The security assertion: the browser-facing schema never learns this scheme,
  // whatever RIVET_EVAL says on the worker.
  it("still refuses a local benchmark URL", () => {
    const parsed = createJobSchema.safeParse({
      title: "Run a benchmark case",
      description: "Should not be creatable from the web form.",
      repoUrl: "rivet-local:fixture-pass",
    });
    expect(parsed.success).toBe(false);
  });
});
