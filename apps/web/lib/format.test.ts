import { describe, expect, it } from "vitest";

import { formatElapsed } from "./format";

const started = new Date("2026-01-01T00:00:00.000Z");

describe("formatElapsed", () => {
  it("says so when the job has not started", () => {
    expect(formatElapsed(null, null)).toBe("not started");
  });

  it("measures a finished run between its own two timestamps", () => {
    expect(formatElapsed(started, new Date("2026-01-01T00:01:30.000Z"))).toBe("1m 30s");
  });

  it("measures a running job against the clock it is given", () => {
    expect(formatElapsed(started, null, new Date("2026-01-01T00:00:21.000Z"))).toBe("21s so far");
  });

  it("never reports negative time when the clocks disagree", () => {
    // Postgres stamps `started_at`; this process supplies `now`. A little skew
    // between them is normal and must not render as "-2s so far".
    expect(formatElapsed(started, null, new Date("2025-12-31T23:59:58.000Z"))).toBe("0s so far");
  });
});
