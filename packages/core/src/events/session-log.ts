import type { JobEventType } from "@rivet/contracts";
import { db, type Executor, jobEvents } from "@rivet/database";
import { and, asc, eq, inArray } from "drizzle-orm";

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
/**
 * The boundary that makes this reader session-aware.
 *
 * A job now runs several sessions - a planner before the implementation, and one
 * more implementation session per recovered attempt - and "the last message in
 * the whole job" stopped being the right answer the moment that became true. A
 * recovered session that ends on a tool call would otherwise inherit the
 * previous session's closing message and present it as its own account of work
 * it did not do, which is exactly the kind of quiet lie the artifact exists to
 * avoid. The planner is the same problem in a milder form: its messages precede
 * every implementation message, so scoping to the newest session excludes them
 * too, for free.
 */
const SESSION_START_EVENT: JobEventType = "agent.session_started";

/** The narrowest shape `summaryFrom` needs, so callers can pass whole events. */
export interface MessageEventLike {
  type: string;
  message: string;
  agentRole?: "planner" | "implementer" | "reviewer";
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
 *
 * The scan stops at the newest `agent.session_started` rather than running off
 * the front of the list, which is what keeps one session's silence from being
 * filled in by an earlier one's summary. A list with no session marker at all -
 * every caller before Milestone 6, and every focused test below - is scanned
 * whole, because there is no boundary to respect.
 */
export function summaryFrom(
  events: readonly MessageEventLike[],
  role?: "implementer",
): string | null {
  // Older rows predate role metadata. Preserve their original whole-stream
  // behavior when no session marker carries a role, because those jobs never
  // had a reviewer that could be mistaken for the implementation session.
  const hasRoleMetadata = events.some(
    (event) => event.type === SESSION_START_EVENT && event.agentRole !== undefined,
  );
  if (role === undefined || !hasRoleMetadata) return summaryFromUnscoped(events);

  // A reviewer runs after the implementer and may be silent, so stopping at the
  // newest session marker would make finalizing lose the implementation summary.
  // Scan backwards through non-implementer sessions, then stop at the newest
  // implementer session. This still prevents a silent replacement implementer
  // from inheriting an older attempt's message.
  let summary: string | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === SESSION_START_EVENT) {
      if (event.agentRole === role) return summary;
      continue;
    }
    if (event?.type !== MESSAGE_EVENT || event.agentRole !== role) continue;
    if (event.message.trim().length > 0 && summary === null) summary = event.message;
  }

  return summary;
}

function summaryFromUnscoped(events: readonly MessageEventLike[]): string | null {
  // Last rather than first, and scanned backwards rather than filtered: a
  // reclaimed attempt runs its own session, and the summary that matters is the
  // one belonging to the session that got here.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === SESSION_START_EVENT) return null;
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
 *
 * The session markers are selected alongside the messages rather than resolved
 * with a second query for the newest session id, so the boundary and the rows it
 * bounds come from one consistent read.
 */
export async function readSummary(jobId: string, executor: Executor = db): Promise<string | null> {
  const rows = await executor
    .select({ type: jobEvents.type, message: jobEvents.message, data: jobEvents.data })
    .from(jobEvents)
    .where(
      and(
        eq(jobEvents.jobId, jobId),
        inArray(jobEvents.type, [MESSAGE_EVENT, SESSION_START_EVENT]),
      ),
    )
    .orderBy(asc(jobEvents.id));

  return summaryFrom(
    rows.map((row) => {
      const agentRole = agentRoleFrom(row.data);
      return {
        type: row.type,
        message: row.message,
        ...(agentRole === undefined ? {} : { agentRole }),
      };
    }),
    "implementer",
  );
}

function agentRoleFrom(value: unknown): MessageEventLike["agentRole"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const role = (value as { agentRole?: unknown }).agentRole;
  return role === "planner" || role === "implementer" || role === "reviewer" ? role : undefined;
}
