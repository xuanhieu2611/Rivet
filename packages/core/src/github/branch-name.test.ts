import { describe, expect, it } from "vitest";

import {
  branchNameForJob,
  deriveBranchName,
  derivePublicationBranch,
  slugifyPublicationTitle,
} from "./branch-name";

describe("publication branch names", () => {
  it.each([
    ["Fix booking race", "rivet/job-12345678-fix-booking-race"],
    ["!!!", "rivet/job-12345678"],
    ["修复并发问题", "rivet/job-12345678-修复并发问题"],
  ])("derives %s deterministically", (title, expected) => {
    expect(deriveBranchName("12345678-aaaa-bbbb-cccc-dddddddddddd", title)).toBe(expected);
  });

  it("accepts the object form and keeps the id before the slug", () => {
    const first = derivePublicationBranch({
      jobId: "aaaaaaaa-1111-2222-3333-444444444444",
      title: "Same title",
    });
    const second = branchNameForJob({
      jobId: "bbbbbbbb-1111-2222-3333-444444444444",
      title: "Same title",
    });

    expect(first).toBe("rivet/job-aaaaaaaa-same-title");
    expect(second).toBe("rivet/job-bbbbbbbb-same-title");
  });

  it("truncates at a word boundary when the title is long", () => {
    const slug = slugifyPublicationTitle(
      "A very long title with enough words to exceed the publication branch slug limit safely",
    );

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe("a-very-long-title-with-enough-words-to");
    expect(deriveBranchName("12345678-aaaa-bbbb-cccc-dddddddddddd", "x".repeat(300))).toHaveLength(
      59,
    );
  });
});
