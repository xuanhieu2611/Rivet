import type { JobCommand, JobEvent } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  createJobLiveState,
  jobEventsUrl,
  jobLiveReducer,
  parseStreamEnd,
  selectJobLiveCommands,
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

  it("shows a running command, pairs completion, and schedules one detail fetch", () => {
    let state = createJobLiveState("provisioning", []);
    state = jobLiveReducer(state, {
      type: "event.received",
      event: commandEvent(10, "command.started", {
        commandExecutionId: "execution-a",
        argv: ["git", "clone"],
        cwd: "/repo",
        phase: "Provision sandbox",
      }),
    });

    expect(selectJobLiveCommands(state)).toMatchObject([
      {
        executionId: "execution-a",
        status: "running",
        commandId: null,
        argv: ["git", "clone"],
      },
    ]);

    state = jobLiveReducer(state, {
      type: "event.received",
      event: commandEvent(11, "command.completed", {
        commandExecutionId: "execution-a",
        commandId: 17,
        argv: ["git", "clone"],
        exitCode: 0,
        durationMs: 250,
        phase: "Provision sandbox",
      }),
    });

    const [completed] = selectJobLiveCommands(state);
    expect(completed).toMatchObject({
      executionId: "execution-a",
      commandId: 17,
      status: "completed",
      exitCode: 0,
      durationMs: 250,
      detailState: { status: "loading" },
    });
  });

  it("keeps unrelated command executions separate and preserves sandbox failures", () => {
    let state = createJobLiveState("provisioning", []);
    state = jobLiveReducer(state, {
      type: "event.received",
      event: commandEvent(12, "command.started", {
        commandExecutionId: "execution-a",
        argv: ["git", "clone"],
        cwd: "/repo",
        phase: "Provision sandbox",
      }),
    });
    state = jobLiveReducer(state, {
      type: "event.received",
      event: commandEvent(13, "command.started", {
        commandExecutionId: "execution-b",
        argv: ["pnpm", "install"],
        cwd: "/repo",
        phase: "Provision sandbox",
      }),
    });
    state = jobLiveReducer(state, {
      type: "event.received",
      event: commandEvent(14, "command.failed", {
        commandExecutionId: "execution-a",
        argv: ["git", "clone"],
        cwd: "/repo",
        phase: "Provision sandbox",
        error: "repository unavailable",
      }),
    });

    expect(selectJobLiveCommands(state)).toMatchObject([
      { executionId: "execution-a", status: "failed", error: "repository unavailable" },
      { executionId: "execution-b", status: "running", argv: ["pnpm", "install"] },
    ]);
  });

  it("replaces a summary with the fetched bounded transcript", () => {
    const summary = {
      id: 17,
      jobId: JOB_ID,
      phase: "testing" as const,
      argv: ["pnpm", "test"],
      cwd: "/repo",
      exitCode: 0,
      durationMs: 100,
      truncated: false,
      timedOut: false,
      oomKilled: false,
      createdAt: CREATED_AT,
    };
    const command: JobCommand = { ...summary, stdout: "passed", stderr: "" };
    let state = createJobLiveState("testing", [], [summary]);

    state = jobLiveReducer(state, { type: "command.detail.requested", commandId: 17 });
    expect(selectJobLiveCommands(state)[0]?.detailState.status).toBe("loading");

    state = jobLiveReducer(state, { type: "command.detail.received", command });
    expect(selectJobLiveCommands(state)[0]?.detail).toEqual(command);
    expect(selectJobLiveCommands(state)[0]?.detailState.status).toBe("loaded");

    const unchanged = jobLiveReducer(state, {
      type: "command.detail.failed",
      commandId: 17,
      error: "stale request",
    });
    expect(unchanged).toBe(state);

    let failed = createJobLiveState("testing", [], [summary]);
    failed = jobLiveReducer(failed, { type: "command.detail.requested", commandId: 17 });
    failed = jobLiveReducer(failed, {
      type: "command.detail.failed",
      commandId: 17,
      error: "temporary network failure",
    });
    expect(selectJobLiveCommands(failed)[0]?.detailState).toEqual({
      status: "error",
      error: "temporary network failure",
    });

    const retried = jobLiveReducer(failed, {
      type: "command.detail.requested",
      commandId: 17,
    });
    expect(selectJobLiveCommands(retried)[0]?.detailState).toEqual({
      status: "loading",
      error: null,
    });
  });
});

function commandEvent(
  id: number,
  type: "command.started" | "command.completed" | "command.failed",
  data: JobEvent["data"],
): JobEvent {
  return {
    id,
    jobId: JOB_ID,
    type,
    message: `${type} ${String(id)}`,
    data,
    createdAt: new Date(CREATED_AT.getTime() + id),
  };
}

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
