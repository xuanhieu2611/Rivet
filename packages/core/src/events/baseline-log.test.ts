import { describe, expect, it } from "vitest";

import { baselineFrom, type BaselineEventLike } from "./baseline-log";

/**
 * The read side of the baseline, against a synthetic event list.
 *
 * No database on purpose: the question "which of these rows is the baseline"
 * is the whole of the logic, and `readBaseline` is one query around it.
 */

const recorded = (baseline: unknown): BaselineEventLike => ({
  type: "baseline.recorded",
  data: { baseline },
});

describe("baselineFrom", () => {
  it("reads each of the three outcomes back", () => {
    expect(baselineFrom([recorded("passed")])).toBe("passed");
    expect(baselineFrom([recorded("failed")])).toBe("failed");
    expect(baselineFrom([recorded("skipped")])).toBe("skipped");
  });

  it("returns null when the phase never ran, which is not `skipped`", () => {
    expect(baselineFrom([])).toBeNull();
    expect(
      baselineFrom([{ type: "phase.completed", data: { phase: "Establish test baseline" } }]),
    ).toBeNull();
  });

  it("ignores every other event type, including one carrying the same key", () => {
    expect(
      baselineFrom([{ type: "job.claimed", data: { baseline: "passed" } }, recorded("failed")]),
    ).toBe("failed");
  });

  it("prefers the latest, because a reclaimed attempt establishes its own", () => {
    expect(baselineFrom([recorded("failed"), recorded("passed")])).toBe("passed");
  });

  it("falls back past a row whose data cannot be read", () => {
    expect(baselineFrom([recorded("failed"), { type: "baseline.recorded", data: null }])).toBe(
      "failed",
    );
    expect(baselineFrom([recorded("failed"), recorded("green")])).toBe("failed");
  });
});
