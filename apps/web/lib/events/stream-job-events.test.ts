import type { JobEvent } from "@rivet/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createJobEventStream,
  SSE_EVENT_LIMIT,
  type StreamJobEventsOptions,
} from "./stream-job-events";

const JOB_ID = "11111111-2222-3333-4444-555555555555";

function makeEvent(id: number, data: JobEvent["data"] = null): JobEvent {
  return {
    id,
    jobId: JOB_ID,
    type: data?.to ? "job.status_changed" : "job.created",
    message: `event ${String(id)}`,
    data,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makeList() {
  return vi.fn<StreamJobEventsOptions["list"]>();
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  for (;;) {
    const result = await reader.read();
    if (result.done) return output;
    output += decoder.decode(result.value);
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ text: string; done: boolean }> {
  const result = await reader.read();
  return {
    text: result.done ? "" : new TextDecoder().decode(result.value),
    done: result.done,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for stream test state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function waitingSleep() {
  let release: (() => void) | undefined;
  const sleep = vi.fn((_milliseconds: number, signal: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("aborted"));
      };
      release = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  return { sleep, release: () => release?.() };
}

describe("createJobEventStream", () => {
  it("drains a full historical page before waiting for the live poll", async () => {
    const list = makeList();
    const firstPage = Array.from({ length: SSE_EVENT_LIMIT }, (_, index) => {
      const id = index + 1;
      return makeEvent(id, id === SSE_EVENT_LIMIT ? { to: "completed" } : null);
    });
    list.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([]);
    const sleep = vi.fn<StreamJobEventsOptions["sleep"]>();

    const stream = createJobEventStream({
      jobId: JOB_ID,
      after: null,
      initialStatus: "queued",
      signal: new AbortController().signal,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
      terminalGraceMs: 0,
      list,
      sleep,
    });

    const output = await readAll(stream);
    const ids = [...output.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));

    expect(ids).toEqual(Array.from({ length: SSE_EVENT_LIMIT }, (_, index) => index + 1));
    expect(list).toHaveBeenNthCalledWith(1, JOB_ID, { limit: SSE_EVENT_LIMIT });
    expect(list).toHaveBeenNthCalledWith(2, JOB_ID, {
      after: SSE_EVENT_LIMIT,
      limit: SSE_EVENT_LIMIT,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(output).toContain('event: stream.end\ndata: {"cursor":200,"status":"completed"}');
  });

  it("delivers a new row after the next poll and keeps the cursor moving", async () => {
    const list = makeList();
    let deliverSecond = false;
    list.mockImplementation(() => {
      if (list.mock.calls.length === 1) return Promise.resolve([makeEvent(1)]);
      return Promise.resolve(deliverSecond ? [makeEvent(2)] : []);
    });
    const waiting = waitingSleep();
    const stream = createJobEventStream({
      jobId: JOB_ID,
      after: null,
      initialStatus: "queued",
      signal: new AbortController().signal,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
      terminalGraceMs: 20,
      list,
      sleep: waiting.sleep,
    });
    const reader = stream.getReader();

    await readChunk(reader);
    await readChunk(reader);
    expect((await readChunk(reader)).text).toContain('"id":1');

    await waitUntil(() => waiting.sleep.mock.calls.length === 1);
    deliverSecond = true;
    waiting.release();
    expect((await readChunk(reader)).text).toContain('"id":2');
    expect(list).toHaveBeenNthCalledWith(2, JOB_ID, { after: 1, limit: SSE_EVENT_LIMIT });

    await reader.cancel();
  });

  it("sends a keepalive comment while an otherwise idle stream remains open", async () => {
    let clock = 0;
    const list = makeList();
    list.mockResolvedValue([]);
    let waitForNextPoll = true;
    const sleep = vi.fn<StreamJobEventsOptions["sleep"]>(async (milliseconds) => {
      clock += milliseconds;
      if (waitForNextPoll) waitForNextPoll = false;
      else await new Promise<void>(() => undefined);
    });

    const stream = createJobEventStream({
      jobId: JOB_ID,
      after: null,
      initialStatus: "queued",
      signal: new AbortController().signal,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 10,
      terminalGraceMs: 20,
      list,
      sleep,
      now: () => clock,
    });
    const reader = stream.getReader();

    await readChunk(reader);
    await readChunk(reader);
    expect((await readChunk(reader)).text).toBe(": keepalive\n\n");

    await reader.cancel();
  });

  it("resets terminal grace when cleanup arrives", async () => {
    let clock = 0;
    const list = makeList();
    list
      .mockResolvedValueOnce([makeEvent(1, { to: "completed" })])
      .mockResolvedValueOnce([makeEvent(2)])
      .mockResolvedValue([]);
    const sleep = vi.fn<StreamJobEventsOptions["sleep"]>((milliseconds) => {
      clock += milliseconds;
      return Promise.resolve();
    });

    const stream = createJobEventStream({
      jobId: JOB_ID,
      after: null,
      initialStatus: "queued",
      signal: new AbortController().signal,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
      terminalGraceMs: 20,
      list,
      sleep,
      now: () => clock,
    });

    const output = await readAll(stream);

    expect(output).toContain('"id":1');
    expect(output).toContain('"id":2');
    expect(output).toContain('event: stream.end\ndata: {"cursor":2,"status":"completed"}');
    expect(list).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("stops polling after the request is cancelled", async () => {
    const list = makeList();
    list.mockResolvedValue([]);
    const waiting = waitingSleep();
    const stream = createJobEventStream({
      jobId: JOB_ID,
      after: null,
      initialStatus: "queued",
      signal: new AbortController().signal,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 1_000,
      terminalGraceMs: 20,
      list,
      sleep: waiting.sleep,
    });
    const reader = stream.getReader();

    await readChunk(reader);
    await readChunk(reader);
    await waitUntil(() => waiting.sleep.mock.calls.length === 1);
    await reader.cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(list).toHaveBeenCalledTimes(1);
  });
});
