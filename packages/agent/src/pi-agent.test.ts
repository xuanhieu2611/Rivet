import { AgentFailedError, AgentUnavailableError } from "@rivet/core";
import { describe, expect, it } from "vitest";

import { classifyHarnessError, RIVET_TOOL_NAMES } from "./pi-agent";

/**
 * The parts of the adapter that can be tested with no key and no SDK.
 *
 * That there are any is itself the claim worth making: this file imports
 * `pi-agent.ts`, and if the harness were loaded at module scope rather than
 * inside `start()`, running this suite would evaluate a terminal UI, a WASM
 * image codec and every provider the harness supports. It does not, which is
 * the same laziness rule `@rivet/database`, `@rivet/queue` and `@rivet/sandbox`
 * follow and the reason CI can run `pnpm test` on a bare machine.
 */

describe("classifyHarnessError", () => {
  it("treats a provider having a bad ten minutes as retryable", () => {
    for (const message of [
      "Request failed with status 429",
      "503 Service Unavailable",
      "upstream is overloaded, please try again",
      "fetch failed",
      "socket hang up",
      "connect ETIMEDOUT 1.2.3.4:443",
    ]) {
      expect(classifyHarnessError(new Error(message))).toBeInstanceOf(AgentUnavailableError);
    }
  });

  it("treats a configuration the provider will refuse again as terminal", () => {
    for (const message of [
      "401 Unauthorized: invalid api key",
      "no such model: gpt-9",
      "the tool schema was rejected",
    ]) {
      expect(classifyHarnessError(new Error(message))).toBeInstanceOf(AgentFailedError);
    }
  });

  it("defaults an unrecognised failure to terminal, never to retryable", () => {
    // The same choice `classify()` makes in the domain: retrying an error
    // nobody has reasoned about turns one bug into three identical bugs, a
    // tripled bill, and a timeline three times as hard to read.
    expect(classifyHarnessError(new Error("something odd"))).toBeInstanceOf(AgentFailedError);
    expect(classifyHarnessError("not even an error")).toBeInstanceOf(AgentFailedError);
  });

  it("keeps the original as the cause, so the message survives the wrapping", () => {
    const original = new Error("429 slow down");
    const classified = classifyHarnessError(original);

    expect(classified.message).toContain("429 slow down");
    expect(classified.cause).toBe(original);
  });
});

describe("RIVET_TOOL_NAMES", () => {
  it("is exactly the four tools the toolbox can back, sorted", () => {
    // Sorted because the assertion in `start()` compares sorted lists, and a
    // list that drifts out of order would turn that check into a coin flip.
    expect([...RIVET_TOOL_NAMES]).toEqual(["bash", "edit", "read", "write"]);
    expect([...RIVET_TOOL_NAMES]).toEqual([...RIVET_TOOL_NAMES].sort());
  });
});
