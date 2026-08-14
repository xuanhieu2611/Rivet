import { describe, expect, it } from "vitest";

import { parseSerializedJobEvent, serializeJobEvent, type JobEvent } from "./job-event";

const EVENT: JobEvent = {
  id: 7,
  jobId: "11111111-2222-3333-8444-555555555555",
  type: "phase.completed",
  message: "Testing completed.",
  data: { phase: "testing", durationMs: 1250 },
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("serialized job events", () => {
  it("serializes and restores event dates", () => {
    const serialized = serializeJobEvent(EVENT);

    expect(serialized.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(parseSerializedJobEvent(serialized)).toEqual(EVENT);
  });

  it("rejects malformed ids, dates, and event types", () => {
    expect(() => parseSerializedJobEvent({ ...serializeJobEvent(EVENT), id: 1.5 })).toThrow();
    expect(() =>
      parseSerializedJobEvent({ ...serializeJobEvent(EVENT), createdAt: "not-a-date" }),
    ).toThrow();
    expect(() =>
      parseSerializedJobEvent({ ...serializeJobEvent(EVENT), type: "unknown.event" }),
    ).toThrow();
  });
});
