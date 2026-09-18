import { describe, expect, it } from "vitest";

import { activeSectionId, jobSections } from "./job-sections";

describe("jobSections", () => {
  it("names the last section for what the job produced", () => {
    expect(jobSections(true).at(-1)).toEqual({ id: "publication", label: "Pull request" });
    expect(jobSections(false).at(-1)).toEqual({ id: "publication", label: "Repository" });
  });

  it("lists the panels in the order the page renders them", () => {
    expect(jobSections(false).map((section) => section.id)).toEqual([
      "timeline",
      "plan",
      "validation",
      "review",
      "artifacts",
      "publication",
    ]);
  });
});

describe("activeSectionId", () => {
  const sections = jobSections(false);

  it("breaks a multi-section tie with document order", () => {
    // Plan and Validation are both in the band; the reader is in Plan.
    expect(activeSectionId(new Set(["validation", "plan"]), sections)).toBe("plan");
  });

  it("follows the reader down the page", () => {
    expect(activeSectionId(new Set(["timeline"]), sections)).toBe("timeline");
    expect(activeSectionId(new Set(["artifacts", "publication"]), sections)).toBe("artifacts");
    expect(activeSectionId(new Set(["publication"]), sections)).toBe("publication");
  });

  it("highlights nothing rather than guessing", () => {
    expect(activeSectionId(new Set(), sections)).toBeNull();
  });

  it("ignores an id that is not a section", () => {
    expect(activeSectionId(new Set(["task", "commands"]), sections)).toBeNull();
  });
});
