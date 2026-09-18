import { describe, expect, it } from "vitest";

import {
  COUNT_UP_MAX_MS,
  COUNT_UP_MIN_MS,
  countUpDurationMs,
  countUpValue,
  easeOutCubic,
} from "./count-up";

describe("easeOutCubic", () => {
  it("clamps outside the unit interval", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(4)).toBe(1);
  });

  it("spends most of its travel early", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.8);
  });
});

describe("countUpDurationMs", () => {
  it("does not animate a value that did not change", () => {
    expect(countUpDurationMs(1_200, 1_200)).toBe(0);
  });

  it("gives the full sweep to a counter whose whole value is new", () => {
    expect(countUpDurationMs(0, 400)).toBe(COUNT_UP_MAX_MS);
  });

  it("scales with the share of the number that changed, not the delta", () => {
    // Half of 40 is new, so half the sweep - and 40 onto 4,000 is the same
    // absolute delta arriving as noise.
    expect(countUpDurationMs(20, 40)).toBe(
      Math.round(COUNT_UP_MIN_MS + (COUNT_UP_MAX_MS - COUNT_UP_MIN_MS) * 0.5),
    );
    expect(countUpDurationMs(20, 40)).toBeGreaterThan(countUpDurationMs(3_960, 4_000));
  });

  it("nearly skips a delta that is noise against the running total", () => {
    const duration = countUpDurationMs(400_000, 400_040);
    expect(duration).toBeGreaterThanOrEqual(COUNT_UP_MIN_MS);
    expect(duration).toBeLessThan(COUNT_UP_MIN_MS + 5);
  });

  it("treats a non-finite bound as nothing to animate", () => {
    expect(countUpDurationMs(Number.NaN, 10)).toBe(0);
  });
});

describe("countUpValue", () => {
  it("lands exactly on the target at and past the end", () => {
    expect(countUpValue(100, 250, 400, 400)).toBe(250);
    expect(countUpValue(100, 250, 10_000, 400)).toBe(250);
  });

  it("starts at the previous value", () => {
    expect(countUpValue(100, 250, 0, 400)).toBe(100);
    expect(countUpValue(100, 250, -16, 400)).toBe(100);
  });

  it("never overshoots between the two", () => {
    for (const elapsed of [1, 50, 120, 399]) {
      const value = countUpValue(100, 250, elapsed, 400);
      expect(value).toBeGreaterThanOrEqual(100);
      expect(value).toBeLessThanOrEqual(250);
    }
  });

  it("counts down as readily as up", () => {
    expect(countUpValue(250, 100, 200, 400)).toBeLessThan(250);
    expect(countUpValue(250, 100, 200, 400)).toBeGreaterThan(100);
  });

  it("jumps straight to the target when there is no duration", () => {
    expect(countUpValue(100, 250, 0, 0)).toBe(250);
  });
});
