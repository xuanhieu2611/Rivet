import { describe, expect, it } from "vitest";

import {
  createJobSchema,
  isTerminal,
  JOB_STATUSES,
  jobStatusSchema,
  TERMINAL_STATUSES,
} from "./job";

const validInput = {
  title: "Add a health check endpoint",
  description: "Return 200 with the build sha at /api/health.",
  repoUrl: "https://github.com/acme/widgets",
};

describe("createJobSchema", () => {
  it("accepts a minimal valid payload and defaults baseBranch to main", () => {
    const result = createJobSchema.parse(validInput);
    expect(result.baseBranch).toBe("main");
    expect(result.title).toBe(validInput.title);
  });

  it("trims surrounding whitespace", () => {
    const result = createJobSchema.parse({
      ...validInput,
      title: "  Padded title  ",
      baseBranch: " develop ",
    });
    expect(result.title).toBe("Padded title");
    expect(result.baseBranch).toBe("develop");
  });

  it("accepts a complete GitHub repository binding", () => {
    const result = createJobSchema.parse({
      ...validInput,
      githubInstallationId: 42,
      repoOwner: "  acme ",
      repoName: " widgets ",
      issueNumber: 17,
      issueUrl: "https://github.com/acme/widgets/issues/17",
    });

    expect(result).toMatchObject({
      githubInstallationId: 42,
      repoOwner: "acme",
      repoName: "widgets",
      issueNumber: 17,
      issueUrl: "https://github.com/acme/widgets/issues/17",
    });
  });

  it("keeps manual repository jobs valid without a GitHub binding", () => {
    expect(createJobSchema.parse(validInput)).not.toHaveProperty("githubInstallationId");
    expect(
      createJobSchema.parse({ ...validInput, repoOwner: "acme", repoName: "widgets" }),
    ).toMatchObject({ repoOwner: "acme", repoName: "widgets" });
  });

  it("requires repository owner and name together", () => {
    expect(createJobSchema.safeParse({ ...validInput, repoOwner: "acme" }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...validInput, repoName: "widgets" }).success).toBe(false);
  });

  it("requires a complete repository binding when an installation is supplied", () => {
    expect(createJobSchema.safeParse({ ...validInput, githubInstallationId: 42 }).success).toBe(
      false,
    );
    expect(
      createJobSchema.safeParse({
        ...validInput,
        githubInstallationId: 42,
        repoOwner: "acme",
      }).success,
    ).toBe(false);
    expect(
      createJobSchema.safeParse({
        ...validInput,
        githubInstallationId: 42,
        repoName: "widgets",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid GitHub binding values", () => {
    for (const githubInstallationId of [0, -1, 1.5, "42"]) {
      expect(createJobSchema.safeParse({ ...validInput, githubInstallationId }).success).toBe(
        false,
      );
    }
    expect(
      createJobSchema.safeParse({ ...validInput, repoOwner: " ", repoName: "widgets" }).success,
    ).toBe(false);
    expect(createJobSchema.safeParse({ ...validInput, issueNumber: 0 }).success).toBe(false);
    expect(
      createJobSchema.safeParse({
        ...validInput,
        issueUrl: "http://github.com/acme/widgets/issues/1",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty title", () => {
    const result = createJobSchema.safeParse({ ...validInput, title: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a title over 200 characters", () => {
    const result = createJobSchema.safeParse({ ...validInput, title: "a".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects a description over 10000 characters", () => {
    const result = createJobSchema.safeParse({ ...validInput, description: "a".repeat(10_001) });
    expect(result.success).toBe(false);
  });

  it("rejects a non-https repo url", () => {
    for (const repoUrl of [
      "http://github.com/acme/widgets",
      "git@github.com:acme/widgets.git",
      "not a url",
    ]) {
      expect(createJobSchema.safeParse({ ...validInput, repoUrl }).success).toBe(false);
    }
  });

  it("reports the offending field", () => {
    const result = createJobSchema.safeParse({ ...validInput, repoUrl: "nope" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["repoUrl"]);
  });

  it("defaults review to one independent reviewer and two loops", () => {
    const result = createJobSchema.parse(validInput);
    expect(result.reviewMode).toBe("independent");
    expect(result.maxReviewLoops).toBe(2);
  });

  it("accepts an explicit review mode and loop bound", () => {
    const result = createJobSchema.parse({
      ...validInput,
      reviewMode: "none",
      maxReviewLoops: 0,
    });
    expect(result.reviewMode).toBe("none");
    expect(result.maxReviewLoops).toBe(0);
  });

  it("rejects an unknown review mode", () => {
    expect(createJobSchema.safeParse({ ...validInput, reviewMode: "off" }).success).toBe(false);
  });

  it("rejects a review loop bound outside 0 through 5", () => {
    for (const maxReviewLoops of [-1, 6, 1.5, "2"]) {
      expect(createJobSchema.safeParse({ ...validInput, maxReviewLoops }).success).toBe(false);
    }
  });
});

describe("jobStatusSchema", () => {
  it("accepts every declared status", () => {
    for (const status of JOB_STATUSES) {
      expect(jobStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects an unknown status", () => {
    expect(jobStatusSchema.safeParse("exploded").success).toBe(false);
  });

  it("declares all 14 lifecycle statuses", () => {
    expect(JOB_STATUSES).toHaveLength(14);
  });
});

describe("isTerminal", () => {
  it("is true for terminal statuses", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminal(status)).toBe(true);
    }
  });

  it("is false for in-flight statuses", () => {
    const inFlight = JOB_STATUSES.filter((status) => !TERMINAL_STATUSES.has(status));
    expect(inFlight).not.toHaveLength(0);
    for (const status of inFlight) {
      expect(isTerminal(status)).toBe(false);
    }
  });

  it("treats queued as non-terminal so the live stream remains open", () => {
    expect(isTerminal("queued")).toBe(false);
  });
});
