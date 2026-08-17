import { FAILURE_CATEGORIES, type FailureCategory } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  autoFailureLabel,
  CLASSIFIED_FAILURE_CATEGORIES,
  EVALUATION_FAILURE_CLASSES,
  isErroredOutcome,
  isToolAssertionFailure,
  TOOL_ASSERTION_MARKER,
  type JobOutcomeFacts,
} from "./run-classification";

function job(overrides: Partial<JobOutcomeFacts> = {}): JobOutcomeFacts {
  return { status: "failed", failureCategory: "unknown", ...overrides };
}

describe("EVALUATION_FAILURE_CLASSES", () => {
  it("classifies every failure category exactly once", () => {
    expect([...CLASSIFIED_FAILURE_CATEGORIES].sort()).toEqual([...FAILURE_CATEGORIES].sort());
    for (const category of FAILURE_CATEGORIES) {
      expect(EVALUATION_FAILURE_CLASSES[category]).toMatch(/^(infrastructure|task)$/);
    }
  });

  it("keeps the task failures on the task side", () => {
    const task: FailureCategory[] = [
      "no_changes_produced",
      "validation_failed",
      "plan_not_produced",
      "review_not_produced",
      "reviewer_rejection",
      "command_timed_out",
    ];
    expect(
      FAILURE_CATEGORIES.filter(
        (category) => EVALUATION_FAILURE_CLASSES[category] === "task",
      ).sort(),
    ).toEqual(task.sort());
  });
});

describe("isErroredOutcome", () => {
  it("errors a job that never reached a judgeable state", () => {
    expect(isErroredOutcome(job({ failureCategory: "sandbox_create_failed" }))).toBe(true);
    expect(isErroredOutcome(job({ status: "timed_out", failureCategory: "timed_out" }))).toBe(true);
    expect(
      isErroredOutcome(job({ status: "budget_exceeded", failureCategory: "budget_exceeded" })),
    ).toBe(true);
    expect(isErroredOutcome(job({ status: "cancelled", failureCategory: null }))).toBe(true);
  });

  it("does not error a task failure", () => {
    expect(isErroredOutcome(job({ failureCategory: "no_changes_produced" }))).toBe(false);
    expect(isErroredOutcome(job({ failureCategory: "reviewer_rejection" }))).toBe(false);
    expect(isErroredOutcome(job({ failureCategory: "command_timed_out" }))).toBe(false);
  });

  it("does not error a completed job", () => {
    expect(isErroredOutcome(job({ status: "completed", failureCategory: null }))).toBe(false);
  });

  it("errors a failed job with no category at all", () => {
    expect(isErroredOutcome(job({ failureCategory: null }))).toBe(true);
  });
});

describe("autoFailureLabel", () => {
  it("derives the labels the data decides", () => {
    expect(
      autoFailureLabel(
        job({ status: "budget_exceeded", failureCategory: "budget_exceeded" }),
        "errored",
      ),
    ).toEqual({ label: "Budget exceeded", source: "auto" });

    for (const category of ["sandbox_create_failed", "repo_unavailable", "oom_killed"] as const) {
      expect(autoFailureLabel(job({ failureCategory: category }), "errored")).toEqual({
        label: "Environment failure",
        source: "auto",
      });
    }

    expect(
      autoFailureLabel(
        job({
          failureCategory: "agent_failed",
          failureReason: `The implementer ${TOOL_ASSERTION_MARKER} [bash, curl] instead of [bash].`,
        }),
        "errored",
      ),
    ).toEqual({ label: "Tool failure", source: "auto" });

    expect(
      autoFailureLabel(
        job({ status: "completed", failureCategory: null, reviewDecision: "approve" }),
        "failed",
      ),
    ).toEqual({ label: "Reviewer false positive", source: "auto" });

    expect(
      autoFailureLabel(
        job({
          status: "completed",
          failureCategory: null,
          turnCeilingReached: true,
          filesChanged: 0,
        }),
        "failed",
      ),
    ).toEqual({ label: "Agent loop", source: "auto" });
  });

  it("leaves the judgement calls unlabelled", () => {
    // The row people will want to delete. `Incorrect diagnosis`,
    // `Insufficient context`, `Bad implementation` and `Test misunderstanding`
    // are not machine-decidable, and guessing them produces a histogram that
    // looks rigorous and is fiction.
    expect(
      autoFailureLabel(job({ status: "completed", failureCategory: null }), "failed"),
    ).toBeNull();
    expect(autoFailureLabel(job({ failureCategory: "validation_failed" }), "failed")).toBeNull();
    expect(
      autoFailureLabel(job({ status: "cancelled", failureCategory: null }), "errored"),
    ).toBeNull();
  });

  it("never labels a passing run", () => {
    expect(
      autoFailureLabel(
        job({ status: "completed", failureCategory: null, reviewDecision: "approve" }),
        "passed",
      ),
    ).toBeNull();
  });

  it("prefers the budget label over the environment one", () => {
    expect(
      autoFailureLabel(job({ status: "budget_exceeded", failureCategory: "timed_out" }), "errored"),
    ).toEqual({ label: "Budget exceeded", source: "auto" });
  });
});

describe("isToolAssertionFailure", () => {
  it("only matches the harness's own assertion", () => {
    expect(isToolAssertionFailure(`the planner ${TOOL_ASSERTION_MARKER} [read]`)).toBe(true);
    expect(isToolAssertionFailure("OpenRouter rejected the API key")).toBe(false);
    expect(isToolAssertionFailure(null)).toBe(false);
    expect(isToolAssertionFailure(undefined)).toBe(false);
  });
});
