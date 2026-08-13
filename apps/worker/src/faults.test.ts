import { type Phase, RetryableJobError, TerminalJobError } from "@rivet/core";
import { pino } from "pino";
import { describe, expect, it } from "vitest";

import { createFaultInjection } from "./faults";

const log = pino({ level: "silent" });

const TESTING: Phase = { status: "testing", label: "Run tests", durationMs: 10 };
const PLANNING: Phase = { status: "planning", label: "Create plan", durationMs: 10 };

describe("createFaultInjection", () => {
  it("injects nothing when no fault is configured", () => {
    const injection = createFaultInjection(undefined, log);

    expect(injection.fault).toBeUndefined();
  });

  it("returns a retryable error at the named phase only", () => {
    const injection = createFaultInjection({ phase: "testing", mode: "throw" }, log);

    expect(injection.fault?.(PLANNING)).toBeUndefined();
    expect(injection.fault?.(TESTING)).toBeInstanceOf(RetryableJobError);
  });

  it("returns a terminal error carrying a real failure category", () => {
    const injection = createFaultInjection({ phase: "testing", mode: "fatal" }, log);

    const error = injection.fault?.(TESTING);
    expect(error).toBeInstanceOf(TerminalJobError);
    expect((error as TerminalJobError).category).toBe("repo_unavailable");
  });

  it("makes only the faulted phase deaf to its abort signal", async () => {
    const injection = createFaultInjection({ phase: "testing", mode: "hang" }, log);
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    // A phase that is not the faulted one still aborts normally, so the
    // timeline shows the run reaching the phase that wedged it.
    injection.fault?.(PLANNING);
    await expect(injection.sleep(1, controller.signal)).rejects.toThrow("stop");

    // The faulted one ignores the signal entirely, which is the whole point:
    // it is what the timeout, rather than the abort, has to catch.
    injection.fault?.(TESTING);
    const hung = injection.sleep(1, controller.signal);
    const raced = await Promise.race([
      hung.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("still hanging"), 20)),
    ]);
    expect(raced).toBe("still hanging");
  });
});
