import { describe, expect, it } from "vitest";

import {
  classify,
  describeError,
  failureCategoryFor,
  JobCancelledError,
  JobTimedOutError,
  LeaseLostError,
  NoChangesProducedError,
  RetryableJobError,
  TerminalJobError,
  ValidationConfigInvalidError,
  ValidationFailedError,
  WorkerShuttingDownError,
} from "./failure";

import {
  PlanNotProducedError,
  ReviewerRejectionError,
  ReviewNotProducedError,
} from "../agent/errors";
import {
  CommandTimedOutError,
  DependencyInstallFailedError,
  OutOfMemoryError,
  RepoUnavailableError,
  SandboxCreateFailedError,
  SandboxUnavailableError,
  UnsupportedProjectError,
} from "../sandbox/errors";

describe("classify", () => {
  it("maps each error type to its outcome", () => {
    expect(classify(new LeaseLostError("gone"))).toBe("lease_lost");
    expect(classify(new WorkerShuttingDownError("sigterm"))).toBe("shutting_down");
    expect(classify(new JobCancelledError("cancelled"))).toBe("cancelled");
    expect(classify(new JobTimedOutError("too slow"))).toBe("timed_out");
    expect(classify(new RetryableJobError("blip"))).toBe("retryable");
    expect(classify(new TerminalJobError("broken"))).toBe("terminal");
  });

  it("treats an unrecognised error as terminal, not retryable", () => {
    // The single most important case in this file. Retrying an error nobody has
    // reasoned about turns one bug into three, at triple the cost. Retryability
    // has to be claimed deliberately.
    expect(classify(new Error("who knows"))).toBe("terminal");
    expect(classify(new TypeError("undefined is not a function"))).toBe("terminal");
    expect(classify("a string")).toBe("terminal");
    expect(classify(undefined)).toBe("terminal");
  });

  it("names each error after its class, so logs are readable", () => {
    expect(new LeaseLostError("x").name).toBe("LeaseLostError");
    expect(new TerminalJobError("x").name).toBe("TerminalJobError");
  });

  it("keeps the underlying cause", () => {
    const cause = new Error("socket hang up");
    expect(new RetryableJobError("wrapped", "unknown", { cause }).cause).toBe(cause);
    expect(new TerminalJobError("wrapped", "unknown", { cause }).cause).toBe(cause);
  });
});

describe("sandbox failure classification", () => {
  const cases = [
    [SandboxUnavailableError, "retryable", "sandbox_unavailable"],
    [SandboxCreateFailedError, "retryable", "sandbox_create_failed"],
    [RepoUnavailableError, "terminal", "repo_unavailable"],
    [UnsupportedProjectError, "terminal", "unsupported_project"],
    [DependencyInstallFailedError, "terminal", "dependency_install_failed"],
    [CommandTimedOutError, "terminal", "command_timed_out"],
    [OutOfMemoryError, "terminal", "oom_killed"],
  ] as const;

  it.each(cases)("classifies %s as %s with category %s", (ErrorType, expectedClass, category) => {
    const error = new ErrorType("injected");

    expect(classify(error)).toBe(expectedClass);
    expect(failureCategoryFor(error)).toBe(category);
  });
});

describe("validation failure classification", () => {
  const cases = [
    [NoChangesProducedError, "no_changes_produced"],
    [ValidationFailedError, "validation_failed"],
    [ValidationConfigInvalidError, "validation_config_invalid"],
  ] as const;

  it.each(cases)("classifies %s as terminal with category %s", (ErrorType, category) => {
    const error = new ErrorType("injected");

    // Terminal on purpose. A session that changed nothing will change nothing
    // again, and re-running one on the chance of better sampling costs another
    // container and another bill to find out.
    expect(classify(error)).toBe("terminal");
    expect(failureCategoryFor(error)).toBe(category);
  });
});

describe("review failure classification", () => {
  it("classifies a missing verdict as terminal, exactly as a missing plan is", () => {
    // A session that never submitted produced nothing durable, and a second
    // attempt asks the same model the same question. The pairing with
    // PlanNotProducedError is the assertion: treating a missing verdict as an
    // approval is the failure this category exists to make impossible.
    expect(classify(new PlanNotProducedError("no plan"))).toBe("terminal");
    expect(failureCategoryFor(new PlanNotProducedError("no plan"))).toBe("plan_not_produced");

    const error = new ReviewNotProducedError("the reviewer never called submit_review");
    expect(classify(error)).toBe("terminal");
    expect(failureCategoryFor(error)).toBe("review_not_produced");
  });

  it("classifies an exhausted review loop as terminal", () => {
    // Retrying would spend another set of loops to reach the same verdict, and
    // completing the job anyway would make review decorative.
    const error = new ReviewerRejectionError("still blocking after 2 revisions", {
      blockingCount: 3,
      reviewLoops: 2,
      maxReviewLoops: 2,
    });

    expect(classify(error)).toBe("terminal");
    expect(failureCategoryFor(error)).toBe("reviewer_rejection");
  });

  it("carries the counts a rejection has to be attributable by", () => {
    const error = new ReviewerRejectionError("rejected", {
      blockingCount: 3,
      reviewLoops: 2,
      maxReviewLoops: 2,
    });

    expect(error.name).toBe("ReviewerRejectionError");
    expect(error.blockingCount).toBe(3);
    expect(error.reviewLoops).toBe(2);
    expect(error.maxReviewLoops).toBe(2);
    expect(describeError(error)).toBe("ReviewerRejectionError: rejected");
  });

  it("keeps the underlying cause on both", () => {
    const cause = new Error("session ended");
    expect(new ReviewNotProducedError("no verdict", { cause }).cause).toBe(cause);
    expect(
      new ReviewerRejectionError(
        "rejected",
        { blockingCount: 1, reviewLoops: 1, maxReviewLoops: 1 },
        { cause },
      ).cause,
    ).toBe(cause);
  });
});

describe("failureCategoryFor", () => {
  it("persists the category a terminal error carries", () => {
    expect(failureCategoryFor(new TerminalJobError("boom", "repo_unavailable"))).toBe(
      "repo_unavailable",
    );
  });

  it("persists the category a retryable error carries", () => {
    expect(failureCategoryFor(new RetryableJobError("blip", "sandbox_unavailable"))).toBe(
      "sandbox_unavailable",
    );
  });

  it("falls back to unknown for an error with no category", () => {
    expect(failureCategoryFor(new TerminalJobError("boom"))).toBe("unknown");
    expect(failureCategoryFor(new RetryableJobError("blip"))).toBe("unknown");
    expect(failureCategoryFor(new Error("boom"))).toBe("unknown");
  });

  it("uses the matching category for cancellation and timeout", () => {
    expect(failureCategoryFor(new JobCancelledError("stop"))).toBe("cancelled");
    expect(failureCategoryFor(new JobTimedOutError("slow"))).toBe("timed_out");
  });
});

describe("describeError", () => {
  it("prefixes the class name so a bare message is never ambiguous", () => {
    expect(describeError(new JobTimedOutError("after 60s"))).toBe("JobTimedOutError: after 60s");
  });

  it("copes with something that is not an error at all", () => {
    expect(describeError("just a string")).toBe("just a string");
  });
});
