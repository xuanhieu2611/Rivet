import { isTerminal, JOB_STATUSES, TERMINAL_STATUSES } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  HAPPY_PATH_SEQUENCE,
  JOB_STATUS_PRESENTATION,
  nextStatus,
  statusLabel,
} from "./job-status";

describe("JOB_STATUS_PRESENTATION", () => {
  it("covers every status in the contract", () => {
    expect(Object.keys(JOB_STATUS_PRESENTATION).sort()).toEqual([...JOB_STATUSES].sort());
    expect(JOB_STATUSES).toHaveLength(14);
  });

  it("gives every status a non-empty label and colour", () => {
    for (const status of JOB_STATUSES) {
      const { label, className } = JOB_STATUS_PRESENTATION[status];
      expect(label.length).toBeGreaterThan(0);
      expect(className.length).toBeGreaterThan(0);
    }
  });

  it("labels statuses without leaking the snake_case enum value", () => {
    expect(statusLabel("budget_exceeded")).toBe("Budget exceeded");
    expect(statusLabel("timed_out")).toBe("Timed out");
  });
});

describe("nextStatus", () => {
  it("walks the happy path in order and stops at completed", () => {
    const walked = ["queued"];
    let current = nextStatus("queued");
    while (current) {
      walked.push(current);
      current = nextStatus(current);
    }
    expect(walked).toEqual([...HAPPY_PATH_SEQUENCE]);
  });

  it("returns null for every terminal status", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminal(status)).toBe(true);
      expect(nextStatus(status)).toBeNull();
    }
  });

  it("never advances past a terminal status", () => {
    expect(nextStatus("finalizing")).toBe("completed");
    expect(nextStatus("completed")).toBeNull();
  });
});
