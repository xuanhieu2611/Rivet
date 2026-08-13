import { JOB_EVENT_TYPES, JOB_STATUSES } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { JOB_EVENT_TONE, JOB_STATUS_PRESENTATION, statusLabel } from "./job-status";

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

describe("JOB_EVENT_TONE", () => {
  it("covers every event type in the contract", () => {
    expect(Object.keys(JOB_EVENT_TONE).sort()).toEqual([...JOB_EVENT_TYPES].sort());
  });

  it("gives every event type a non-empty marker colour", () => {
    for (const type of JOB_EVENT_TYPES) {
      expect(JOB_EVENT_TONE[type].length).toBeGreaterThan(0);
    }
  });
});
