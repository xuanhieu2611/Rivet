import { describe, expect, it } from "vitest";

import {
  classify,
  describeError,
  failureCategoryFor,
  JobCancelledError,
  JobTimedOutError,
  LeaseLostError,
  RetryableJobError,
  TerminalJobError,
  WorkerShuttingDownError,
} from "./failure";

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
    expect(new RetryableJobError("wrapped", { cause }).cause).toBe(cause);
  });
});

describe("failureCategoryFor", () => {
  it("persists the category a terminal error carries", () => {
    expect(failureCategoryFor(new TerminalJobError("boom", "simulated_failure"))).toBe(
      "simulated_failure",
    );
  });

  it("falls back to unknown for a terminal error with no category", () => {
    expect(failureCategoryFor(new TerminalJobError("boom"))).toBe("unknown");
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
