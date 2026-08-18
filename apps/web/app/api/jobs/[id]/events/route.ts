import "server-only";

import type { JobEvent } from "@rivet/contracts";
import { getJob, listEvents } from "@rivet/core";
import { NextResponse } from "next/server";

import { badRequest, notFound, serverError } from "@/lib/api/responses";
import { requireSession } from "@/lib/auth/guard";
import { resolveEventCursor } from "@/lib/events/cursor";
import {
  createJobEventStream,
  sleepWithAbort,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_POLL_INTERVAL_MS,
  SSE_TERMINAL_GRACE_MS,
} from "@/lib/events/stream-job-events";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface EventsResponse {
  events: JobEvent[];
  cursor: number | null;
}

/** `Accept` may contain several comma-separated media types and parameters. */
function acceptsEventStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((value) => {
    const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
    return mediaType === "text/event-stream";
  });
}

/** `GET /api/jobs/:id/events` - JSON incrementally, or SSE when requested. */
export const GET = withRoute(
  "/api/jobs/:id/events",
  async (request: Request, telemetry: RouteTelemetry, context: RouteContext) => {
    const auth = await requireSession(request);
    if (auth) return auth;

    const url = new URL(request.url);
    const after = resolveEventCursor(
      url.searchParams.get("after"),
      request.headers.get("last-event-id"),
    );
    if (after === undefined) {
      return badRequest("`after` and `Last-Event-ID` must be non-negative integer event ids.");
    }

    try {
      // Check existence before opening a stream. Once SSE headers are committed,
      // an unknown job could only be reported as a broken response rather than a
      // useful 404.
      const job = await getJob((await context.params).id);
      if (!job) return notFound("Job not found.");

      if (!acceptsEventStream(request)) {
        const events = await listEvents(job.id, after === null ? {} : { after });
        const body: EventsResponse = {
          events,
          cursor: events.at(-1)?.id ?? after,
        };
        return NextResponse.json(body);
      }

      const stream = createJobEventStream({
        jobId: job.id,
        after,
        initialStatus: job.status,
        signal: request.signal,
        pollIntervalMs: SSE_POLL_INTERVAL_MS,
        heartbeatIntervalMs: SSE_HEARTBEAT_INTERVAL_MS,
        terminalGraceMs: SSE_TERMINAL_GRACE_MS,
        list: listEvents,
        sleep: sleepWithAbort,
      });

      return new Response(stream, {
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (cause) {
      return serverError("GET /api/jobs/:id/events", cause, telemetry.log);
    }
  },
);
