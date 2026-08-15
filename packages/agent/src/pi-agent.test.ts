import { AgentFailedError, AgentUnavailableError } from "@rivet/core";
import { describe, expect, it } from "vitest";

import {
  classifyHarnessError,
  RIVET_PLANNER_TOOL_NAMES,
  RIVET_REVIEWER_TOOL_NAMES,
  RIVET_TOOL_NAMES,
  toolNamesForRole,
} from "./pi-agent";

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

describe("RIVET_PLANNER_TOOL_NAMES", () => {
  it("is exactly the planner's read-only tools, sorted", () => {
    expect([...RIVET_PLANNER_TOOL_NAMES]).toEqual([
      "list_files",
      "read",
      "search_text",
      "submit_plan",
    ]);
    expect([...RIVET_PLANNER_TOOL_NAMES]).toEqual([...RIVET_PLANNER_TOOL_NAMES].sort());
  });
});

describe("RIVET_REVIEWER_TOOL_NAMES", () => {
  it("is exactly the reviewer's four read-only tools, sorted", () => {
    expect([...RIVET_REVIEWER_TOOL_NAMES]).toEqual([
      "list_files",
      "read",
      "search_text",
      "submit_review",
    ]);
    expect([...RIVET_REVIEWER_TOOL_NAMES]).toEqual([...RIVET_REVIEWER_TOOL_NAMES].sort());
  });

  it("gives the reviewer no way to change the diff it is judging", () => {
    // The read-only claim, as a test rather than as a sentence. `start()`
    // refuses a session whose active tools are not exactly this list, so a
    // harness upgrade that reintroduced a default shell fails one job loudly
    // instead of handing a reviewer the ability to edit what it is reviewing.
    for (const forbidden of ["bash", "write", "edit"]) {
      expect(RIVET_REVIEWER_TOOL_NAMES).not.toContain(forbidden);
    }
  });
});

describe("toolNamesForRole", () => {
  it("gives each role its own capability set", () => {
    expect(toolNamesForRole("reviewer")).toEqual([
      "list_files",
      "read",
      "search_text",
      "submit_review",
    ]);
    expect(toolNamesForRole("planner")).toBe(RIVET_PLANNER_TOOL_NAMES);
    expect(toolNamesForRole("implementer")).toBe(RIVET_TOOL_NAMES);
  });

  it("never hands one role another role's tools", () => {
    // The failure this exists to prevent is silent: a ternary defaulting to the
    // planner would give a reviewer `submit_plan` and no way to record a
    // verdict, and one defaulting to the implementer would give it a shell.
    expect(toolNamesForRole("reviewer")).not.toEqual([...RIVET_PLANNER_TOOL_NAMES]);
    expect(toolNamesForRole("reviewer")).not.toEqual([...RIVET_TOOL_NAMES]);
  });
});
