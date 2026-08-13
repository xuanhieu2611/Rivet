import "server-only";

import type { JobEvent } from "@rivet/contracts";
import { getJob, listEvents } from "@rivet/core";
import { NextResponse } from "next/server";

import { badRequest, notFound, serverError } from "@/lib/api/responses";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * The incremental-fetch envelope.
 *
 * `cursor` is the id to send back as `?after=` next time, and it is deliberately
 * echoed rather than left null on an empty page: a poller that keeps asking
 * "anything after 42?" must not silently rewind to the start of the timeline
 * when the answer is "not yet". It is also what caps the page size safely -
 * `listEvents` returns at most `DEFAULT_EVENT_LIMIT` rows, and following the
 * cursor is how a caller walks the rest.
 *
 * Milestone 3 replaces the transport with SSE and reuses this id as
 * `Last-Event-ID`, which is the reason the cursor is being designed now: M3
 * should change how events arrive, not what they are.
 */
interface EventsResponse {
  events: JobEvent[];
  cursor: number | null;
}

/** `?after=` must be a non-negative integer. Junk is a 400, not a silent reset. */
function parseAfter(raw: string | null): number | null | undefined {
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

/** `GET /api/jobs/:id/events?after=<id>` - one job's timeline, oldest first. */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;

  const after = parseAfter(new URL(request.url).searchParams.get("after"));
  if (after === undefined) {
    return badRequest("`after` must be a non-negative integer event id.");
  }

  try {
    // Checked so an unknown job is a 404 rather than an empty timeline. A job
    // that exists but has no events yet is not the same fact as a job that does
    // not exist, and a client polling this endpoint needs to tell them apart.
    const job = await getJob(id);
    if (!job) return notFound("Job not found.");

    const events = await listEvents(id, after === null ? {} : { after });
    const body: EventsResponse = {
      events,
      cursor: events.at(-1)?.id ?? after,
    };
    return NextResponse.json(body);
  } catch (cause) {
    return serverError("GET /api/jobs/:id/events", cause);
  }
}
