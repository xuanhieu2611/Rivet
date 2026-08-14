import type { JobEventType } from "@rivet/contracts";
import { db, type Executor, jobEvents } from "@rivet/database";
import { and, asc, eq } from "drizzle-orm";

/**
 * Reading the session's own account of its work back out of the event log.
 *
 * `implementing` writes one `agent.message` row per completed assistant
 * message, and the last of them is the implementation summary: the model's
 * description of what it changed and why, produced because the task
 * instructions ask for it. `finalizing` persists that as the
 * `implementation_summary` artifact.
 *
 * Read back rather than handed over, and for the same reason the baseline is -
 * see `baseline-log.ts`. `runPipeline` is a flat walk that passes no state
 * between phases, so a fact that only ever lived in `SessionAccounting`'s memory
 * would be a fact that does not survive the phase that produced it, let alone
 * the process. The event log is already the source of truth for replay, so it is
 * the source of truth for this too, and Milestone 6 resuming a job into
 * `finalizing` in a new worker gets the same answer this one does.
 *
 * What is read back is the same text the timeline carries, which the coding
 * agent port already truncated to `previewMaxBytes`. That is the honest bound:
 * this module recovers *which message was last*, not a fidelity the row never
 * had.
 *
 * There is no writer here. `agent.message` is written by `implementing` through
 * `ctx.event()` like every other row.
 */

const MESSAGE_EVENT: JobEventType = "agent.message";

/** The narrowest shape `summaryFrom` needs, so callers can pass whole events. */
export interface MessageEventLike {
  type: string;
  message: string;
}

/**
 * The last thing the model said, or null when it never said anything.
 *
 * Null is a real answer rather than a missing one, and the two cases it covers
 * are both worth being able to see: a session that ended on a tool call said
 * nothing at the end, and a job that reached `finalizing` without ever running a
 * session has no messages at all. `finalizing` records the absence plainly
 * instead of synthesizing a summary, because an invented one is worse than an
 * admitted gap - only one of the two can be told apart from a real summary
 * afterwards.
 *
 * Whitespace does not count. A model that ends on a blank message has said
 * nothing, and keeping that would replace a real summary from an earlier turn
 * with an empty one - the same rule `SessionAccounting` applies while the
 * session is still running.
 */
export function summaryFrom(events: readonly MessageEventLike[]): string | null {
  // Last rather than first, and scanned backwards rather than filtered: a
  // reclaimed attempt runs a second session, and the summary that matters is the
  // one belonging to the attempt that got here.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== MESSAGE_EVENT) continue;
    if (event.message.trim().length > 0) return event.message;
  }
  return null;
}

/**
 * The same question, against the database.
 *
 * Ordered ascending and reduced in memory rather than ordered descending and
 * limited to one, because "the last non-empty message" is not a predicate the
 * index can answer: the newest row may well be an empty one. A session leaves
 * tens of these behind rather than thousands - Milestone 4 declined to write an
 * event per token for exactly this kind of reason - so there is nothing here
 * worth bounding.
 */
export async function readSummary(jobId: string, executor: Executor = db): Promise<string | null> {
  const rows = await executor
    .select({ type: jobEvents.type, message: jobEvents.message })
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), eq(jobEvents.type, MESSAGE_EVENT)))
    .orderBy(asc(jobEvents.id));

  return summaryFrom(rows);
}
