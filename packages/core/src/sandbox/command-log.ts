import type { JobCommand, JobCommandSummary, JobStatus } from "@rivet/contracts";
import { db, type Executor, type JobCommandRow, jobCommands } from "@rivet/database";

import type { ExecResult } from "./sandbox";

/**
 * The append-only log of commands a job ran inside its sandbox.
 *
 * The same two rules as `events/event-service.ts`, for the same reason: nothing
 * here ever updates or deletes a row, and every function takes an `Executor` so
 * a command row can be written inside the transaction that records what the
 * command meant. This is the only writer of `job_commands`.
 */

/** Head and tail are kept; the middle is replaced by a line stating what went. */
const ELISION_PREFIX = "\n... ";
const ELISION_SUFFIX = " bytes elided ...\n";

export interface TruncatedText {
  text: string;
  truncated: boolean;
  /** How many bytes the middle lost. Zero when nothing was dropped. */
  elidedBytes: number;
}

/**
 * Caps a transcript at `maxBytes`, keeping the beginning and the end.
 *
 * Keeping only the head is the obvious implementation and the wrong one: a
 * failing command says why it failed on its last few lines, and a transcript
 * that silently loses its ending is worse than one that says it did. So both
 * ends survive and the marker in between states the byte count, which is also
 * what makes `truncated` honest rather than decorative.
 *
 * The cut is made on UTF-8 character boundaries. Slicing a multi-byte character
 * in half would put a replacement character in a transcript that is supposed to
 * be evidence of what a command printed, so the head backs up and the tail moves
 * forward until both land on a real boundary. That is why the result can be a
 * byte or two under the cap and never over it.
 *
 * The marker itself is *not* counted against `maxBytes` - it is Rivet's own
 * text, not the command's, and making the cap cover it would mean the amount of
 * output kept depends on how much was thrown away.
 */
export function truncate(text: string, maxBytes: number): TruncatedText {
  const limit = Math.max(0, Math.floor(maxBytes));
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= limit) {
    return { text, truncated: false, elidedBytes: 0 };
  }

  const headBytes = Math.ceil(limit / 2);
  const tailBytes = limit - headBytes;
  return renderTruncated(
    bytes.subarray(0, headBytes),
    tailBytes === 0 ? EMPTY : bytes.subarray(bytes.byteLength - tailBytes),
    bytes.byteLength - headBytes - tailBytes,
  );
}

/** How `truncate` splits a cap between the two ends it keeps. */
export function truncationSplit(maxBytes: number): { headBytes: number; tailBytes: number } {
  const limit = Math.max(0, Math.floor(maxBytes));
  const headBytes = Math.ceil(limit / 2);
  return { headBytes, tailBytes: limit - headBytes };
}

/**
 * Assembles a truncated transcript from the two ends that survived.
 *
 * Split out from `truncate` because the sandbox adapter never has the whole
 * text: it caps output as it streams, precisely so that a command printing a
 * gigabyte costs a bounded amount of memory rather than an unbounded one. It
 * keeps the two ends and a byte count, and hands them here, so the format is
 * produced in one place instead of two that can drift.
 *
 * Both ends are trimmed back to a UTF-8 boundary and whatever that costs is
 * added to the elided count, which is what keeps kept-plus-elided equal to what
 * came in.
 */
export function renderTruncated(head: Buffer, tail: Buffer, elidedBytes: number): TruncatedText {
  const keptHead = trimTrailingPartialChar(head);
  const keptTail = trimLeadingContinuation(tail);
  const elided =
    elidedBytes + (head.byteLength - keptHead.byteLength) + (tail.byteLength - keptTail.byteLength);

  return {
    text: `${keptHead.toString("utf8")}${ELISION_PREFIX}${elided}${ELISION_SUFFIX}${keptTail.toString("utf8")}`,
    truncated: true,
    elidedBytes: elided,
  };
}

const EMPTY = Buffer.alloc(0);

/** Drops a final character whose remaining bytes were cut off. */
function trimTrailingPartialChar(buffer: Buffer): Buffer {
  let start = buffer.byteLength - 1;
  while (start >= 0 && isContinuationByte(buffer[start])) start -= 1;
  if (start < 0) return EMPTY;

  const expected = charByteLength(buffer[start]);
  return start + expected <= buffer.byteLength ? buffer : buffer.subarray(0, start);
}

/** Drops leading bytes that belong to a character whose start was cut off. */
function trimLeadingContinuation(buffer: Buffer): Buffer {
  let index = 0;
  while (index < buffer.byteLength && isContinuationByte(buffer[index])) index += 1;
  return buffer.subarray(index);
}

/** True for a byte that continues a multi-byte UTF-8 character, `10xxxxxx`. */
function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** How many bytes the character starting with this byte occupies. */
function charByteLength(byte: number | undefined): number {
  if (byte === undefined) return 1;
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  // Not a valid leading byte at all. Treating it as one byte keeps the invalid
  // sequence intact rather than deleting evidence of what the command printed.
  return 1;
}

export interface RecordCommandInput {
  jobId: string;
  /** The status the job was in while the command ran. */
  phase: JobStatus;
  result: ExecResult;
}

/**
 * Writes one command's row.
 *
 * Argument order follows `appendEvent`, not the executor-first shape: an input
 * object and an optional `Executor` that defaults to the pool. Pass the
 * transaction and the row lands atomically with the event that describes it.
 */
export async function recordCommand(
  input: RecordCommandInput,
  executor: Executor = db,
): Promise<JobCommand> {
  const { result } = input;
  const [row] = await executor
    .insert(jobCommands)
    .values({
      jobId: input.jobId,
      phase: input.phase,
      argv: result.argv,
      cwd: result.cwd,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
      oomKilled: result.oomKilled,
    })
    .returning();

  if (!row) {
    throw new Error("Insert into job_commands returned no row.");
  }
  return toJobCommand(row);
}

/** Maps a database row to the contract shape. */
export function toJobCommand(row: JobCommandRow): JobCommand {
  return { ...toJobCommandSummary(row), stdout: row.stdout, stderr: row.stderr };
}

/** The same, without the transcript, for list queries. */
export function toJobCommandSummary(row: JobCommandRow): JobCommandSummary {
  return {
    id: row.id,
    jobId: row.jobId,
    // The column is `text` rather than the `job_status` pgEnum on purpose - see
    // the schema - and this process is its only writer, so an unrecognised
    // value could only come from a newer build of Rivet.
    phase: row.phase as JobStatus,
    argv: row.argv,
    cwd: row.cwd,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    truncated: row.truncated,
    timedOut: row.timedOut,
    oomKilled: row.oomKilled,
    createdAt: row.createdAt,
  };
}
