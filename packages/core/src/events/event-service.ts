import type { JobEvent, JobEventData, JobEventType } from "@rivet/contracts";
import { db, type Executor, type JobEventRow, jobEvents } from "@rivet/database";
import { and, asc, eq, gt } from "drizzle-orm";

/**
 * The append-only job event log.
 *
 * Two rules make the log trustworthy. Nothing here ever updates or deletes a
 * row, and an event describing a status change is written by `transitionJob`
 * inside the same transaction as the change itself - which is why every
 * function takes an `Executor` rather than reaching for `db` directly. Pass a
 * transaction and the write joins it; pass nothing and it runs on the pool.
 */

/** Newest-first is wrong for a timeline, so reads cap rather than reverse. */
export const DEFAULT_EVENT_LIMIT = 200;

export interface AppendEventInput {
  jobId: string;
  type: JobEventType;
  /** One human-readable line. This is what the timeline renders. */
  message: string;
  data?: JobEventData;
}

/** Maps a database row to the contract shape. */
export function toJobEvent(row: JobEventRow): JobEvent {
  return {
    id: row.id,
    jobId: row.jobId,
    // The column is `text` and this process is the only writer, so an
    // unrecognised value could only come from a newer build of Rivet. Widening
    // the contract to `string` to cover that would cost every consumer an
    // exhaustiveness check it does not need.
    type: row.type as JobEventType,
    message: row.message,
    // The column is typed `Record<string, unknown>` because the database
    // package cannot see `JobEventData` without a circular dependency. Nothing
    // outside `appendEvent` writes it, and `appendEvent` takes the precise type.
    data: row.data ?? null,
    createdAt: row.createdAt,
  };
}

/** Records that something happened to a job. */
export async function appendEvent(
  input: AppendEventInput,
  executor: Executor = db,
): Promise<JobEvent> {
  const [row] = await executor
    .insert(jobEvents)
    .values({
      jobId: input.jobId,
      type: input.type,
      message: input.message,
      ...(input.data ? { data: input.data } : {}),
    })
    .returning();

  if (!row) {
    throw new Error("Insert into job_events returned no row.");
  }
  return toJobEvent(row);
}

export interface ListEventsOptions {
  /**
   * Return only events with an id greater than this.
   *
   * The cursor shared by the JSON events response and the SSE route at
   * `GET /api/jobs/:id/events?after=`. The SSE transport carries the same value
   * as `Last-Event-ID`, so both callers replay the same durable rows.
   */
  after?: number;
  limit?: number;
}

/** One job's events in the order they happened. */
export async function listEvents(
  jobId: string,
  options: ListEventsOptions = {},
  executor: Executor = db,
): Promise<JobEvent[]> {
  const rows = await executor
    .select()
    .from(jobEvents)
    .where(
      and(
        eq(jobEvents.jobId, jobId),
        options.after === undefined ? undefined : gt(jobEvents.id, options.after),
      ),
    )
    // Ascending by id, which is also chronological: a single lease holder is
    // the only writer for a given job, so ids cannot arrive out of order.
    .orderBy(asc(jobEvents.id))
    .limit(options.limit ?? DEFAULT_EVENT_LIMIT);

  return rows.map(toJobEvent);
}
