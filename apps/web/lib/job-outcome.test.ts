import { TERMINAL_STATUSES } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { describeJobOutcome } from "./job-outcome";

const BASE = {
  failureCategory: null,
  pullRequestUrl: null,
  failureReason: null,
} as const;

describe("describeJobOutcome", () => {
  it("answers every terminal status with a headline and a detail", () => {
    for (const status of TERMINAL_STATUSES) {
      const outcome = describeJobOutcome({ ...BASE, status });
      expect(outcome.headline.length, status).toBeGreaterThan(0);
      expect(outcome.detail.length, status).toBeGreaterThan(0);
    }
  });

  it("is positive only for a completed job", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(describeJobOutcome({ ...BASE, status }).tone === "positive", status).toBe(
        status === "completed",
      );
    }
  });

  it("says where a completed change ended up", () => {
    const published = describeJobOutcome({
      ...BASE,
      status: "completed",
      pullRequestUrl: "https://github.com/acme/widgets/pull/7",
    });
    const unpublished = describeJobOutcome({ ...BASE, status: "completed" });

    expect(published.detail).toContain("pull request");
    expect(unpublished.detail).toContain("Nothing was published");
  });

  it("leads a failure with its category and keeps the recorded reason", () => {
    const outcome = describeJobOutcome({
      ...BASE,
      status: "failed",
      failureCategory: "validation_failed",
      failureReason: "The full test check regressed.",
    });

    expect(outcome.tone).toBe("negative");
    expect(outcome.detail).toBe("Validation failed. The full test check regressed.");
  });

  it("says so when a failure carries no category", () => {
    const outcome = describeJobOutcome({ ...BASE, status: "failed" });
    expect(outcome.detail).toBe("No failure category was recorded.");
  });

  it("treats a cancellation as neither a success nor a failure", () => {
    expect(describeJobOutcome({ ...BASE, status: "cancelled" }).tone).toBe("neutral");
  });
});
