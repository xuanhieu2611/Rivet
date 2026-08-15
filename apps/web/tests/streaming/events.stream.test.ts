import type { JobEvent, JobStatus } from "@rivet/contracts";
import { appendEvent, createJob, listEvents, transitionJob } from "@rivet/core";
import { closeDb, db } from "@rivet/database";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CoreModule {
  listEvents: typeof listEvents;
}

vi.mock("server-only", () => ({}));
vi.mock("@rivet/core", async (importOriginal) => {
  const actual = await importOriginal<CoreModule>();
  return { ...actual, listEvents: vi.fn(actual.listEvents) };
});

import { GET } from "@/app/api/jobs/[id]/events/route";

import { SSE_POLL_INTERVAL_MS } from "@/lib/events/stream-job-events";

interface WireJobEvent extends Omit<JobEvent, "createdAt"> {
  createdAt: string;
}

interface StreamEnd {
  cursor: number | null;
  status: string;
}

interface SseFrame {
  id?: number;
  event?: string;
  data?: string;
}

const activeReaders = new Set<SseReader>();
const listEventsMock = vi.mocked(listEvents);

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async nextFrame(): Promise<SseFrame> {
    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const block = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        return parseSseBlock(block);
      }

      const { value, done } = await this.reader.read();
      if (done) throw new Error("SSE stream ended before the expected frame.");
      this.buffer += this.decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
    }
  }

  async nextJobEvent(): Promise<WireJobEvent> {
    for (;;) {
      const frame = await this.nextFrame();
      if (frame.event !== "job.event") continue;
      if (frame.data === undefined) throw new Error("Job event frame did not contain data.");
      const event = JSON.parse(frame.data) as WireJobEvent;
      if (frame.id !== event.id) {
        throw new Error(`SSE id ${String(frame.id)} did not match event id ${String(event.id)}.`);
      }
      return event;
    }
  }

  async nextStreamEnd(): Promise<StreamEnd> {
    for (;;) {
      const frame = await this.nextFrame();
      if (frame.event !== "stream.end") continue;
      if (frame.id !== undefined) throw new Error("stream.end must not have a durable event id.");
      if (frame.data === undefined) throw new Error("stream.end frame did not contain data.");
      return JSON.parse(frame.data) as StreamEnd;
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel();
  }
}

function parseSseBlock(block: string): SseFrame {
  const frame: SseFrame = {};
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "id") frame.id = Number(value);
    if (field === "event") frame.event = value;
    if (field === "data") data.push(value);
  }

  if (data.length > 0) frame.data = data.join("\n");
  return frame;
}

function routeContext(jobId: string) {
  return { params: Promise.resolve({ id: jobId }) };
}

async function openStream(
  jobId: string,
  options: { after?: number; lastEventId?: number } = {},
): Promise<SseReader> {
  const url = new URL(`http://localhost/api/jobs/${jobId}/events`);
  if (options.after !== undefined) url.searchParams.set("after", String(options.after));

  const headers = new Headers({ Accept: "text/event-stream" });
  if (options.lastEventId !== undefined) {
    headers.set("Last-Event-ID", String(options.lastEventId));
  }

  const response = await GET(new Request(url, { headers }), routeContext(jobId));
  if (!response.ok) throw new Error(`Expected an SSE response, got ${response.status}.`);
  if (!response.body) throw new Error("SSE response did not contain a body.");

  const reader = new SseReader(response.body);
  activeReaders.add(reader);
  return reader;
}

async function createTestJob() {
  return createJob({
    title: "Streaming integration job",
    description: "Created by the real-Postgres streaming suite.",
    repoUrl: "https://github.com/rivet/example",
    baseBranch: "main",
  });
}

async function appendTestEvent(jobId: string, sequence: number): Promise<JobEvent> {
  return appendEvent({
    jobId,
    type: "phase.started",
    message: `Streaming phase ${String(sequence)} started`,
    data: { phase: `stream-${String(sequence)}` },
  });
}

async function readAllEvents(jobId: string): Promise<JobEvent[]> {
  return listEvents(jobId, { limit: 500 });
}

async function transitionToFinalizing(jobId: string): Promise<void> {
  const path: readonly (readonly [JobStatus, JobStatus])[] = [
    ["queued", "provisioning"],
    ["provisioning", "analyzing"],
    ["analyzing", "planning"],
    ["planning", "implementing"],
    ["implementing", "testing"],
    ["testing", "reviewing"],
    ["reviewing", "finalizing"],
  ];

  for (const [from, to] of path) {
    await transitionJob({ jobId, from, to, message: `Transitioned from ${from} to ${to}.` });
  }
}

async function completeJob(jobId: string): Promise<void> {
  await transitionToFinalizing(jobId);
  await transitionJob({
    jobId,
    from: "finalizing",
    to: "completed",
    message: "Job completed.",
  });
}

async function resetDatabase(): Promise<void> {
  await db.execute(sql`truncate table job_events, jobs restart identity cascade`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for streaming test state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function eventIds(events: readonly { id: number }[]): number[] {
  return events.map((event) => event.id);
}

describe("GET /api/jobs/:id/events against Postgres", () => {
  beforeEach(async () => {
    await resetDatabase();
    listEventsMock.mockClear();
  });

  afterEach(async () => {
    await Promise.all([...activeReaders].map((reader) => reader.cancel()));
    activeReaders.clear();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("sends an ordered historical backlog after the supplied cursor", async () => {
    const job = await createTestJob();
    await appendTestEvent(job.id, 1);
    await appendTestEvent(job.id, 2);
    await appendTestEvent(job.id, 3);
    const events = await readAllEvents(job.id);
    const after = events[1]?.id;
    if (after === undefined) throw new Error("Expected a job-created event and backlog rows.");

    listEventsMock.mockClear();
    const reader = await openStream(job.id, { after });
    const received: WireJobEvent[] = [];
    const expected = events.filter((event) => event.id > after);
    for (const _event of expected) {
      received.push(await reader.nextJobEvent());
    }

    expect(eventIds(received)).toEqual(eventIds(expected));
    expect(received.map((event) => event.createdAt)).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    await reader.cancel();
  });

  it("replays the M5 validation and artifact event types with their durable data", async () => {
    const job = await createTestJob();
    const [created] = await readAllEvents(job.id);
    if (!created) throw new Error("Expected the job-created event.");

    const expected = [
      await appendEvent({
        jobId: job.id,
        type: "plan.deferred",
        message: "No plan was produced.",
      }),
      await appendEvent({
        jobId: job.id,
        type: "artifact.recorded",
        message: "Recorded the diff.",
        data: { artifactId: 1, artifactType: "diff", byteSize: 20, truncated: false },
      }),
      await appendEvent({
        jobId: job.id,
        type: "validation.recorded",
        message: "Fixed the baseline failure.",
        data: {
          validation: "fixed",
          filesChanged: 1,
          insertions: 2,
          deletions: 1,
        },
      }),
      await appendEvent({
        jobId: job.id,
        type: "run.summarized",
        message: "Run finished fixed.",
        data: {
          validation: "fixed",
          filesChanged: 1,
          insertions: 2,
          deletions: 1,
        },
      }),
    ];

    const reader = await openStream(job.id, { after: created.id });
    const received: WireJobEvent[] = [];
    for (const _event of expected) received.push(await reader.nextJobEvent());

    expect(received.map((event) => event.type)).toEqual([
      "plan.deferred",
      "artifact.recorded",
      "validation.recorded",
      "run.summarized",
    ]);
    expect(received[1]?.data).toMatchObject({
      artifactType: "diff",
      byteSize: 20,
      truncated: false,
    });
    expect(received[2]?.data).toMatchObject({
      validation: "fixed",
      filesChanged: 1,
      insertions: 2,
      deletions: 1,
    });
    await reader.cancel();
  });

  it("replays the M6 planning and recovery event types with their durable data", async () => {
    // The recovery rows are the ones a viewer most needs to arrive intact: a
    // reader watching a job get reclaimed is watching the transport prove that
    // its own worker dying did not lose the timeline.
    const job = await createTestJob();
    const [created] = await readAllEvents(job.id);
    if (!created) throw new Error("Expected the job-created event.");

    const expected = [
      await appendEvent({
        jobId: job.id,
        type: "plan.recorded",
        message: "Recorded an implementation plan.",
        data: { artifactId: 7, artifactType: "implementation_plan", byteSize: 512 },
      }),
      await appendEvent({
        jobId: job.id,
        type: "checkpoint.created",
        message: "Captured checkpoint 3 after turn 2.",
        data: {
          checkpointId: 3,
          checkpointSequence: 3,
          checkpointKind: "agent_turn",
          turn: 2,
          attempt: 1,
          patchByteSize: 480,
          filesChanged: 1,
          insertions: 2,
          deletions: 1,
        },
      }),
      await appendEvent({
        jobId: job.id,
        type: "job.reclaimed",
        message: "Reclaimed an expired lease.",
        data: { attempt: 2, dispatchGeneration: 1, leaseOwner: "worker-a" },
      }),
      await appendEvent({
        jobId: job.id,
        type: "checkpoint.restored",
        message: "Restored checkpoint 3 into a new sandbox.",
        data: {
          checkpointSequence: 3,
          checkpointKind: "agent_turn",
          resumePhase: "implementing",
          originalSandboxId: "container-a",
          replacementSandboxId: "container-b",
          patchSha256: "a".repeat(64),
          patchByteSize: 480,
        },
      }),
      await appendEvent({
        jobId: job.id,
        type: "run.resumed",
        message: "Resuming at implementing from checkpoint 3.",
        data: { checkpointSequence: 3, resumePhase: "implementing", attempt: 2 },
      }),
      await appendEvent({
        jobId: job.id,
        type: "checkpoint.rejected",
        message: "A checkpoint could not be restored.",
        data: { checkpointSequence: 3, failureCategory: "checkpoint_restore_failed" },
      }),
    ];

    const reader = await openStream(job.id, { after: created.id });
    const received: WireJobEvent[] = [];
    for (const _event of expected) received.push(await reader.nextJobEvent());

    expect(eventIds(received)).toEqual(eventIds(expected));
    expect(received.map((event) => event.type)).toEqual([
      "plan.recorded",
      "checkpoint.created",
      "job.reclaimed",
      "checkpoint.restored",
      "run.resumed",
      "checkpoint.rejected",
    ]);
    expect(received[1]?.data).toMatchObject({
      checkpointSequence: 3,
      checkpointKind: "agent_turn",
      turn: 2,
      patchByteSize: 480,
    });
    // Both sandbox ids survive the wire, because they are the pair that proves
    // recovery rebuilt an environment rather than reusing one.
    expect(received[3]?.data).toMatchObject({
      originalSandboxId: "container-a",
      replacementSandboxId: "container-b",
      resumePhase: "implementing",
    });
    await reader.cancel();
  });

  it("reconnects across a reclaim without duplicating or dropping a checkpoint row", async () => {
    const job = await createTestJob();
    const [created] = await readAllEvents(job.id);
    if (!created) throw new Error("Expected the job-created event.");

    const captured = await appendEvent({
      jobId: job.id,
      type: "checkpoint.created",
      message: "Captured checkpoint 1.",
      data: { checkpointSequence: 1, checkpointKind: "agent_turn", patchByteSize: 120 },
    });

    const firstReader = await openStream(job.id, { after: created.id });
    expect((await firstReader.nextJobEvent()).id).toBe(captured.id);
    await firstReader.cancel();

    // The viewer's worker died here; the events it missed were written by
    // another one entirely.
    const afterDisconnect = [
      await appendEvent({
        jobId: job.id,
        type: "job.reclaimed",
        message: "Reclaimed an expired lease.",
        data: { attempt: 2, dispatchGeneration: 1 },
      }),
      await appendEvent({
        jobId: job.id,
        type: "run.resumed",
        message: "Resuming at implementing from checkpoint 1.",
        data: { checkpointSequence: 1, resumePhase: "implementing", attempt: 2 },
      }),
    ];

    const secondReader = await openStream(job.id, {
      after: created.id,
      lastEventId: captured.id,
    });
    const received = [await secondReader.nextJobEvent(), await secondReader.nextJobEvent()];

    expect(eventIds(received)).toEqual(eventIds(afterDisconnect));
    await secondReader.cancel();
  });

  it("delivers an event appended after the stream is already live", async () => {
    const job = await createTestJob();
    const [created] = await readAllEvents(job.id);
    if (!created) throw new Error("Expected the job-created event.");

    listEventsMock.mockClear();
    const reader = await openStream(job.id, { after: created.id });
    await waitFor(() => listEventsMock.mock.calls.length >= 1);

    const startedAt = Date.now();
    const nextEvent = reader.nextJobEvent();
    const appended = await appendTestEvent(job.id, 1);
    const received = await nextEvent;

    expect(received.id).toBe(appended.id);
    expect(received.type).toBe("phase.started");
    expect(Date.now() - startedAt).toBeLessThan(SSE_POLL_INTERVAL_MS * 3);
    await reader.cancel();
  });

  it("reconnects from Last-Event-ID without gaps", async () => {
    const job = await createTestJob();
    await appendTestEvent(job.id, 1);
    await appendTestEvent(job.id, 2);
    await appendTestEvent(job.id, 3);
    const initialEvents = await readAllEvents(job.id);
    const after = initialEvents[0]?.id;
    const expectedFirstConnection = initialEvents.slice(1);
    const lastBeforeDisconnect = expectedFirstConnection.at(-1)?.id;
    if (after === undefined || lastBeforeDisconnect === undefined) {
      throw new Error("Expected initial streaming events.");
    }

    listEventsMock.mockClear();
    const firstReader = await openStream(job.id, { after });
    const firstReceived: WireJobEvent[] = [];
    for (const _event of expectedFirstConnection) {
      firstReceived.push(await firstReader.nextJobEvent());
    }
    expect(eventIds(firstReceived)).toEqual(eventIds(expectedFirstConnection));
    await firstReader.cancel();

    const appended = [
      await appendTestEvent(job.id, 4),
      await appendTestEvent(job.id, 5),
      await appendTestEvent(job.id, 6),
    ];

    const secondReader = await openStream(job.id, {
      after,
      lastEventId: lastBeforeDisconnect,
    });
    const secondReceived: WireJobEvent[] = [];
    for (const _event of appended) {
      secondReceived.push(await secondReader.nextJobEvent());
    }

    expect(eventIds(secondReceived)).toEqual(eventIds(appended));
    await secondReader.cancel();
  });

  it("uses the newer Last-Event-ID when the reconnect URL has an older cursor", async () => {
    const job = await createTestJob();
    await appendTestEvent(job.id, 1);
    await appendTestEvent(job.id, 2);
    await appendTestEvent(job.id, 3);
    const events = await readAllEvents(job.id);
    const oldCursor = events[0]?.id;
    const newCursor = events[2]?.id;
    const expected = events[3];
    if (oldCursor === undefined || newCursor === undefined || expected === undefined) {
      throw new Error("Expected enough events to exercise cursor precedence.");
    }

    const reader = await openStream(job.id, { after: oldCursor, lastEventId: newCursor });
    const received = await reader.nextJobEvent();

    expect(received.id).toBe(expected.id);
    await reader.cancel();
  });

  it("delivers the same durable event to two viewers", async () => {
    const job = await createTestJob();
    const [created] = await readAllEvents(job.id);
    if (!created) throw new Error("Expected the job-created event.");

    listEventsMock.mockClear();
    const firstReader = await openStream(job.id, { after: created.id });
    const secondReader = await openStream(job.id, { after: created.id });
    await waitFor(() => listEventsMock.mock.calls.length >= 2);

    const appended = await appendTestEvent(job.id, 1);
    const [first, second] = await Promise.all([
      firstReader.nextJobEvent(),
      secondReader.nextJobEvent(),
    ]);

    expect(first.id).toBe(appended.id);
    expect(second.id).toBe(appended.id);
    await firstReader.cancel();
    await secondReader.cancel();
  });

  it("stops querying after a cancelled response", async () => {
    const job = await createTestJob();
    const [created] = await readAllEvents(job.id);
    if (!created) throw new Error("Expected the job-created event.");

    listEventsMock.mockClear();
    const reader = await openStream(job.id, { after: created.id });
    await waitFor(() => listEventsMock.mock.calls.length >= 1);
    await reader.cancel();

    await new Promise<void>((resolve) => setTimeout(resolve, SSE_POLL_INTERVAL_MS + 100));
    expect(listEventsMock).toHaveBeenCalledTimes(1);
  });

  it("drains cleanup events written after a terminal transition", async () => {
    const job = await createTestJob();
    const [created] = await readAllEvents(job.id);
    if (!created) throw new Error("Expected the job-created event.");

    const reader = await openStream(job.id, { after: created.id });
    await transitionToFinalizing(job.id);
    await transitionJob({
      jobId: job.id,
      from: "finalizing",
      to: "completed",
      message: "Job completed.",
    });

    let terminalEvent: WireJobEvent | undefined;
    while (terminalEvent?.data?.to !== "completed") {
      terminalEvent = await reader.nextJobEvent();
    }

    const cleanup = await appendEvent({
      jobId: job.id,
      type: "sandbox.destroyed",
      message: "Sandbox destroyed.",
      data: { containerId: "streaming-test-container" },
    });
    const cleanupReceived = await reader.nextJobEvent();
    const end = await reader.nextStreamEnd();

    expect(terminalEvent.data?.to).toBe("completed");
    expect(cleanupReceived.id).toBe(cleanup.id);
    expect(end).toMatchObject({ cursor: cleanup.id, status: "completed" });
  });

  it("closes a stream opened for an already-terminal job", async () => {
    const job = await createTestJob();
    await completeJob(job.id);
    const expected = await readAllEvents(job.id);

    const reader = await openStream(job.id);
    const received: WireJobEvent[] = [];
    for (const _event of expected) {
      received.push(await reader.nextJobEvent());
    }
    const end = await reader.nextStreamEnd();

    expect(eventIds(received)).toEqual(eventIds(expected));
    expect(end).toMatchObject({ cursor: expected.at(-1)?.id, status: "completed" });
  });

  it("keeps the JSON cursor envelope for non-SSE callers", async () => {
    const job = await createTestJob();
    await appendTestEvent(job.id, 1);
    const expected = await readAllEvents(job.id);

    listEventsMock.mockClear();
    const response = await GET(
      new Request(`http://localhost/api/jobs/${job.id}/events`),
      routeContext(job.id),
    );
    const body = (await response.json()) as { events: JobEvent[]; cursor: number | null };

    expect(response.status).toBe(200);
    expect(eventIds(body.events)).toEqual(eventIds(expected));
    expect(body.cursor).toBe(expected.at(-1)?.id);
    expect(listEventsMock).toHaveBeenCalledWith(job.id, {});
  });

  it("returns 404 for an unknown job before opening an SSE response", async () => {
    const unknownJobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    listEventsMock.mockClear();

    const response = await GET(
      new Request(`http://localhost/api/jobs/${unknownJobId}/events`, {
        headers: { Accept: "text/event-stream" },
      }),
      routeContext(unknownJobId),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(listEventsMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid cursor before touching the database", async () => {
    listEventsMock.mockClear();

    const response = await GET(
      new Request(
        "http://localhost/api/jobs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/events?after=1.5",
      ),
      routeContext("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    );

    expect(response.status).toBe(400);
    expect(listEventsMock).not.toHaveBeenCalled();
  });
});
