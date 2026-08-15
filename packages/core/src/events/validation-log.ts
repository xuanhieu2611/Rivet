import {
  type JobEventType,
  parseSerializedValidationReport,
  VALIDATION_OUTCOMES,
  type ValidationOutcome,
  type ValidationReport,
} from "@rivet/contracts";
import { db, type Executor, jobArtifacts, jobEvents } from "@rivet/database";
import { and, asc, desc, eq } from "drizzle-orm";

/**
 * Reading the validation result back out of the event log.
 *
 * `testing` compares the re-run suite against the baseline and writes the answer
 * on a `validation.recorded` row, carrying the diff totals alongside it.
 * `finalizing` states both on the run's closing line, so the last entry on a
 * timeline says what happened rather than that something did.
 *
 * The third module of this shape, and the reasoning has not changed since
 * `baseline-log.ts`: phases hand nothing to each other, so a phase that needs a
 * fact an earlier one established goes back to the log for it. That the two
 * phases here are adjacent in the walk is not a reason to make an exception -
 * `reviewing` sits between them today, and Milestone 6 will resume a job into
 * `finalizing` in a process that never ran `testing` at all.
 *
 * There is no writer here.
 */

const VALIDATION_EVENT: JobEventType = "validation.recorded";

/** The narrowest shape `validationFrom` needs, so callers can pass whole events. */
export interface ValidationEventLike {
  type: string;
  data: Record<string, unknown> | null;
}

/** What `testing` concluded, and how much the session had changed to conclude it about. */
export interface ValidationRecord {
  outcome: ValidationOutcome;
  /**
   * The parsed `--numstat` totals, present when the row carried all three.
   *
   * All three or none, because that is how `testing` writes them: they are one
   * parse of one command, and a row carrying two of them would mean something
   * has gone wrong with the row rather than with the diff.
   */
  stat?: DiffTotals;
}

export interface DiffTotals {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * The latest validation a job recorded, or null when it never recorded one.
 *
 * Null is not `unverified`. `unverified` means the comparison ran and had
 * nothing to compare against; null means no comparison happened - a job whose
 * pipeline had no agent, so `testing` was still a sleep, or one that has not
 * reached `testing` yet. The closing line says something different for each,
 * because reporting "nothing was checked" for a run that was never going to
 * check anything would read as a fault in a job that had none.
 */
export function validationFrom(events: readonly ValidationEventLike[]): ValidationRecord | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== VALIDATION_EVENT) continue;

    const outcome = event.data?.validation;
    if (!isValidationOutcome(outcome)) continue;

    const stat = totalsFrom(event.data);
    return stat ? { outcome, stat } : { outcome };
  }
  return null;
}

/** The same question, against the database. */
export async function readValidation(
  jobId: string,
  executor: Executor = db,
): Promise<ValidationRecord | null> {
  const rows = await executor
    .select({ type: jobEvents.type, data: jobEvents.data })
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), eq(jobEvents.type, VALIDATION_EVENT)))
    .orderBy(asc(jobEvents.id));

  return validationFrom(rows.map((row) => ({ type: row.type, data: row.data ?? null })));
}

export interface ValidationReportArtifactLike {
  content: string;
  truncated: boolean;
}

/**
 * Parses the newest validation report artifact, or null when it cannot be trusted.
 *
 * Only the newest row is eligible. A malformed report from a newer attempt must
 * not silently substitute an older attempt's result; finalizing falls back to
 * the unchanged `validation.recorded` reader instead.
 */
export function validationReportFrom(
  rowsNewestFirst: readonly ValidationReportArtifactLike[],
): ValidationReport | null {
  const row = rowsNewestFirst[0];
  if (!row || row.truncated) return null;
  try {
    return parseSerializedValidationReport(row.content);
  } catch {
    return null;
  }
}

/** The latest complete structured validation report, against the database. */
export async function readValidationReport(
  jobId: string,
  executor: Executor = db,
): Promise<ValidationReport | null> {
  const [row] = await executor
    .select({ content: jobArtifacts.content, truncated: jobArtifacts.truncated })
    .from(jobArtifacts)
    .where(and(eq(jobArtifacts.jobId, jobId), eq(jobArtifacts.type, "validation_report")))
    .orderBy(desc(jobArtifacts.id))
    .limit(1);

  return validationReportFrom(row ? [row] : []);
}

function totalsFrom(data: Record<string, unknown> | null | undefined): DiffTotals | undefined {
  const filesChanged = countFrom(data?.filesChanged);
  const insertions = countFrom(data?.insertions);
  const deletions = countFrom(data?.deletions);
  if (filesChanged === undefined || insertions === undefined || deletions === undefined) {
    return undefined;
  }
  return { filesChanged, insertions, deletions };
}

function countFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isValidationOutcome(value: unknown): value is ValidationOutcome {
  return typeof value === "string" && VALIDATION_OUTCOMES.includes(value as ValidationOutcome);
}
