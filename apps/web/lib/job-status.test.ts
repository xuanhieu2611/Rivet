import { JOB_EVENT_TYPES, JOB_STATUSES } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  isProgressStatus,
  JOB_EVENT_MARKER,
  JOB_EVENT_TONE,
  JOB_STATUS_PRESENTATION,
  STATUS_TONE_CLASSNAME,
  statusLabel,
} from "./job-status";

describe("JOB_STATUS_PRESENTATION", () => {
  it("covers every status in the contract", () => {
    expect(Object.keys(JOB_STATUS_PRESENTATION).sort()).toEqual([...JOB_STATUSES].sort());
    expect(JOB_STATUSES).toHaveLength(14);
  });

  it("gives every status a non-empty label, an icon and a colour", () => {
    for (const status of JOB_STATUSES) {
      const { label, className, icon } = JOB_STATUS_PRESENTATION[status];
      expect(label.length).toBeGreaterThan(0);
      expect(className.length).toBeGreaterThan(0);
      expect(icon).toBeTypeOf("object");
    }
  });

  it("spends exactly four surfaces across fourteen statuses", () => {
    const surfaces = new Set(
      JOB_STATUSES.map((status) => JOB_STATUS_PRESENTATION[status].className),
    );

    // The point of the collapse: a badge answers good / bad / working, and the
    // phase is read from the label and the glyph. A fifteenth surface here
    // means somebody has started encoding phase in hue again.
    expect(surfaces.size).toBe(4);
    expect([...surfaces].sort()).toEqual(Object.values(STATUS_TONE_CLASSNAME).sort());
  });

  it("puts every non-terminal working status in the progress tone", () => {
    for (const status of [
      "provisioning",
      "analyzing",
      "planning",
      "implementing",
      "testing",
      "reviewing",
      "revising",
      "finalizing",
    ] as const) {
      expect(isProgressStatus(status)).toBe(true);
    }

    for (const status of ["queued", "completed", "failed", "cancelled"] as const) {
      expect(isProgressStatus(status)).toBe(false);
    }
  });

  it("reads every unsuccessful ending the same way", () => {
    const attention = JOB_STATUS_PRESENTATION.failed.className;
    expect(JOB_STATUS_PRESENTATION.budget_exceeded.className).toBe(attention);
    expect(JOB_STATUS_PRESENTATION.timed_out.className).toBe(attention);
    expect(JOB_STATUS_PRESENTATION.completed.className).not.toBe(attention);
  });

  it("labels statuses without leaking the snake_case enum value", () => {
    expect(statusLabel("budget_exceeded")).toBe("Budget exceeded");
    expect(statusLabel("timed_out")).toBe("Timed out");
  });
});

describe("JOB_EVENT_MARKER", () => {
  it("covers every event type in the contract", () => {
    expect(Object.keys(JOB_EVENT_MARKER).sort()).toEqual([...JOB_EVENT_TYPES].sort());
    expect(Object.keys(JOB_EVENT_TONE).sort()).toEqual([...JOB_EVENT_TYPES].sort());
  });

  it("gives every event type a glyph and two non-empty colours", () => {
    for (const type of JOB_EVENT_TYPES) {
      const { icon, dot, text } = JOB_EVENT_MARKER[type];
      expect(icon).toBeTypeOf("object");
      expect(dot).toBeTypeOf("string");
      expect(dot.length).toBeGreaterThan(0);
      expect(text).toBeTypeOf("string");
      expect(text.length).toBeGreaterThan(0);
      expect(JOB_EVENT_TONE[type]).toBe(dot);
    }
  });

  it("spends one accent rather than two", () => {
    // Teal and sky were indistinguishable at marker size, so the hue carried a
    // distinction nobody could read. The glyph carries it now, and a reviewer
    // reaching for a second blue-green here should fail this instead.
    for (const type of JOB_EVENT_TYPES) {
      const { dot, text } = JOB_EVENT_MARKER[type];
      expect(`${dot} ${text}`).not.toMatch(/\b(sky|teal)-/);
    }
  });
});
