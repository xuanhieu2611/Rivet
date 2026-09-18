import { describe, expect, it } from "vitest";

import { formatRelativeTime, relativeTimeRefreshMs } from "./relative-time";

const NOW = new Date("2026-09-17T14:00:00.000Z");

function ago(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}

describe("formatRelativeTime", () => {
  it("reads the recent past in the largest unit that still says something", () => {
    expect(formatRelativeTime(ago(2_000), NOW)).toBe("just now");
    expect(formatRelativeTime(ago(44_000), NOW)).toBe("just now");
    expect(formatRelativeTime(ago(60_000), NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(ago(4 * 60_000), NOW)).toBe("4 minutes ago");
    expect(formatRelativeTime(ago(59 * 60_000), NOW)).toBe("59 minutes ago");
    expect(formatRelativeTime(ago(60 * 60_000), NOW)).toBe("1 hour ago");
    expect(formatRelativeTime(ago(5 * 60 * 60_000), NOW)).toBe("5 hours ago");
    expect(formatRelativeTime(ago(26 * 60 * 60_000), NOW)).toBe("1 day ago");
    expect(formatRelativeTime(ago(9 * 24 * 60 * 60_000), NOW)).toBe("9 days ago");
  });

  it("never rounds down to zero of a unit", () => {
    // 90 minutes rounds to 2 hours, not to "0 hours"; 45 seconds must not
    // become "0 minutes ago" at the boundary either.
    expect(formatRelativeTime(ago(45_000), NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(ago(90 * 60_000), NOW)).toBe("2 hours ago");
  });

  it("gives up past a month so the absolute date is kept instead", () => {
    expect(formatRelativeTime(ago(31 * 24 * 60 * 60_000), NOW)).toBeNull();
    expect(formatRelativeTime(new Date("2020-01-01T00:00:00.000Z"), NOW)).toBeNull();
  });

  it("treats a slightly skewed clock as now and a real future as unformattable", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + 500), NOW)).toBe("just now");
    expect(formatRelativeTime(new Date(NOW.getTime() + 10 * 60_000), NOW)).toBeNull();
  });
});

describe("relativeTimeRefreshMs", () => {
  it("ticks faster while the label changes faster", () => {
    expect(relativeTimeRefreshMs(ago(10_000), NOW)).toBe(15_000);
    expect(relativeTimeRefreshMs(ago(3 * 60 * 60_000), NOW)).toBe(60_000);
    expect(relativeTimeRefreshMs(ago(3 * 24 * 60 * 60_000), NOW)).toBe(3_600_000);
  });
});
