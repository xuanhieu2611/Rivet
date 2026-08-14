import type { JobEvent } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  createJobLiveState,
  jobEventsUrl,
  jobLiveReducer,
  parseStreamEnd,
  selectJobLiveEvents,
} from "./stream-state";

const JOB_ID = "11111111-2222-3333-4444-555555555555";
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

function event(id: number, data: JobEvent["data"] = null): JobEvent {
  return {
    id,
    jobId: JOB_ID,
    type: data?.to ? "job.status_changed" : "phase.started",
    message: `event ${String(id)}`,
    data,
    createdAt: CREATED_AT,
  };
}

describe("job live reducer", () => {
  it("starts with sorted, deduplicated events and the newest status", () => {
    const state = createJobLiveState("queued", [
      event(3, { to: "testing" }),
      event(1),
      event(3, { to: "testing" }),
    ]);

    expect(selectJobLiveEvents(state).map((item) => item.id)).toEqual([1, 3]);
    expect(state.lastEventId).toBe(3);
    expect(state.status).toBe("testing");
    expect(state.connection).toBe("connecting");
  });

  it("appends events once and ignores a duplicate delivery", () => {
    const initial = createJobLiveState("queued", [event(1)]);
    const next = jobLiveReducer(initial, {
      type: "event.received",
      event: event(2, { to: "implementing" }),
    });
    const duplicate = jobLiveReducer(next, {
      type: "event.received",
      event: event(2, { to: "implementing" }),
    });

    expect(selectJobLiveEvents(next).map((item) => item.id)).toEqual([1, 2]);
    expect(next.status).toBe("implementing");
    expect(next.lastEventId).toBe(2);
    expect(duplicate).toBe(next);
  });

  it("never moves the cursor or status backward for an older event", () => {
    const initial = createJobLiveState("testing", [event(8, { to: "testing" })]);
    const next = jobLiveReducer(initial, {
      type: "event.received",
      event: event(4, { to: "provisioning" }),
    });

    expect(selectJobLiveEvents(next).map((item) => item.id)).toEqual([4, 8]);
    expect(next.lastEventId).toBe(8);
    expect(next.status).toBe("testing");
  });

  it("updates the connection and finishes at the stream cursor", () => {
    const initial = createJobLiveState("testing", [event(8)]);
    const live = jobLiveReducer(initial, {
      type: "connection.changed",
      connection: "live",
    });
    const finished = jobLiveReducer(live, {
      type: "stream.finished",
      cursor: 9,
      status: "completed",
    });

    expect(live.connection).toBe("live");
    expect(finished.connection).toBe("finished");
    expect(finished.status).toBe("completed");
    expect(finished.lastEventId).toBe(9);
  });
});

describe("job event stream helpers", () => {
  it("keeps the cursor in the URL for a new connection", () => {
    expect(jobEventsUrl(JOB_ID, null)).toBe(`/api/jobs/${JOB_ID}/events`);
    expect(jobEventsUrl(JOB_ID, 42)).toBe(`/api/jobs/${JOB_ID}/events?after=42`);
  });

  it("validates the terminal frame", () => {
    expect(parseStreamEnd({ cursor: 42, status: "completed" })).toEqual({
      cursor: 42,
      status: "completed",
    });
    expect(() => parseStreamEnd({ cursor: 1.5, status: "completed" })).toThrow();
    expect(() => parseStreamEnd({ cursor: 1, status: "running" })).toThrow();
  });
});
