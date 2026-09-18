import { describe, expect, it } from "vitest";

import { isActive } from "./app-nav";

describe("isActive", () => {
  it("marks the section you are looking at", () => {
    expect(isActive("/jobs", "/jobs")).toBe(true);
    expect(isActive("/evaluations", "/evaluations")).toBe(true);
  });

  it("keeps the section marked from inside it", () => {
    // A job detail page is still Jobs; losing the highlight on navigation is
    // the bug this exists to prevent.
    expect(isActive("/jobs/2b1f/", "/jobs")).toBe(true);
    expect(isActive("/jobs/new", "/jobs")).toBe(true);
    expect(isActive("/evaluations/7", "/evaluations")).toBe(true);
    expect(isActive("/settings/github", "/settings/github")).toBe(true);
  });

  it("does not let a prefix match a sibling", () => {
    expect(isActive("/jobs-archive", "/jobs")).toBe(false);
    expect(isActive("/settings/github-enterprise", "/settings/github")).toBe(false);
  });

  it("marks nothing elsewhere", () => {
    expect(isActive("/evaluations", "/jobs")).toBe(false);
    expect(isActive("/", "/jobs")).toBe(false);
    expect(isActive(null, "/jobs")).toBe(false);
  });
});
