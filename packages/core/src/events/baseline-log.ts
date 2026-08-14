import type { JobEventData, JobEventType } from "@rivet/contracts";
import { db, type Executor, jobEvents } from "@rivet/database";
import { and, asc, eq } from "drizzle-orm";

/**
 * Reading the baseline back out of the event log.
 *
 * `analyzing` establishes whether the repository was already broken and writes
 * that on a `baseline.recorded` row. Two later phases need the answer:
 * `implementing` tells the model about it, and `testing` compares its own run
 * against it. Neither reads it from a run-scoped object in memory, and that is
 * the whole point of this module.
 *
 * The alternative - thread the outcome through the object `runPipeline` already
 * passes from phase to phase - is shorter and wrong for exactly one reason.
 * Milestone 6 resumes a job in a new worker process, where the previous
 * process's memory is gone; a fact that only ever lived there is a fact M6 would
 * have to re-derive by re-running the suite, which is the one thing the baseline
 * must not do twice. The event log is already the source of truth for replay, so
 * it is the source of truth for this too.
 *
 * There is no writer here. `baseline.recorded` is written by `baselinePhase`
 * through `ctx.event()` like every other row, because an event log with two
 * writing paths is an event log that eventually disagrees with itself.
 */

/** What `analyzing` concluded. `skipped` is a real answer, not a missing one. */
export type BaselineOutcome = NonNullable<JobEventData["baseline"]>;

const BASELINE_EVENT: JobEventType = "baseline.recorded";

const BASELINE_OUTCOMES: readonly BaselineOutcome[] = ["passed", "failed", "skipped"];

/** The narrowest shape `baselineFrom` needs, so callers can pass whole events. */
export interface BaselineEventLike {
  type: string;
  data: Record<string, unknown> | null;
}

/**
 * The latest baseline a job recorded, or null when it never recorded one.
 *
 * Null is not `skipped`. `skipped` means `analyzing` looked and found nothing to
 * run; null means the phase has not happened - a job resumed into
 * `implementing`, or an older row from before this event existed. The context
 * builder says something different for each, because telling a model "no
 * baseline could be established" when in fact nobody has tried yet would send it
 * looking for a missing test script that is right there.
 */
export function baselineFrom(events: readonly BaselineEventLike[]): BaselineOutcome | null {
  // Last rather than first: a reclaimed attempt runs `analyzing` again, and the
  // baseline that matters is the one this attempt established.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== BASELINE_EVENT) continue;
    const value = event.data?.baseline;
    if (isBaselineOutcome(value)) return value;
  }
  return null;
}

/** The same question, against the database. */
export async function readBaseline(
  jobId: string,
  executor: Executor = db,
): Promise<BaselineOutcome | null> {
  // Every `baseline.recorded` row for the job rather than one, because "latest"
  // has to survive a row whose `data` is unreadable - a job with three attempts
  // has three of these and no more, so there is nothing to bound.
  const rows = await executor
    .select({ type: jobEvents.type, data: jobEvents.data })
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), eq(jobEvents.type, BASELINE_EVENT)))
    .orderBy(asc(jobEvents.id));

  return baselineFrom(rows.map((row) => ({ type: row.type, data: row.data ?? null })));
}

function isBaselineOutcome(value: unknown): value is BaselineOutcome {
  return typeof value === "string" && BASELINE_OUTCOMES.includes(value as BaselineOutcome);
}
