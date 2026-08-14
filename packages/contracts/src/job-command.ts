import { z } from "zod";

import { jobStatusSchema, type JobStatus } from "./job";

/**
 * One command executed inside a job's sandbox.
 *
 * A separate table from `job_events` rather than a fat event payload, because
 * the event log is read in full on every timeline render and is supposed to hold
 * small facts. A `pnpm install` transcript is neither. The timeline keeps a
 * command lifecycle, with `command.completed` carrying the `commandId`; the
 * transcript lives one join away and is fetched lazily by the live command log.
 *
 * Append-only, like `job_events`. Nothing ever updates a row.
 */
export interface JobCommand extends JobCommandSummary {
  /** Truncated head+tail to `SANDBOX_MAX_OUTPUT_BYTES`, with the elision marked inline. */
  stdout: string;
  stderr: string;
}

/**
 * What a list query reads back: everything except the transcript.
 *
 * The split exists so the detail page can render argv, exit code and duration
 * for every command a job ran without pulling every byte those commands wrote.
 */
export interface JobCommandSummary {
  /** Globally monotonic, same reasoning as `JobEvent.id`. Also the cursor. */
  id: number;
  jobId: string;
  /** The `JobStatus` the job was in while the command ran. */
  phase: JobStatus;
  /** The command as an argument vector. Never a shell string, so there are no quoting bugs. */
  argv: string[];
  cwd: string;
  /** Null when the command was killed - by its own timeout, by an abort, or by the OOM killer. */
  exitCode: number | null;
  durationMs: number;
  /** True when output hit the cap and the stored transcript has a gap in the middle. */
  truncated: boolean;
  timedOut: boolean;
  oomKilled: boolean;
  createdAt: Date;
}

/** The JSON shape used when a command summary crosses a server/client boundary. */
export type SerializedJobCommandSummary = Omit<JobCommandSummary, "createdAt"> & {
  createdAt: string;
};

/** The JSON shape used when a command transcript crosses a server/client boundary. */
export type SerializedJobCommand = Omit<JobCommand, "createdAt"> & { createdAt: string };

const safeCommandIdSchema = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "Command id must be a safe integer.");

const commandDateSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Command date must be a valid ISO date.");

const serializedJobCommandSummarySchema = z.object({
  id: safeCommandIdSchema,
  jobId: z.string().min(1),
  phase: jobStatusSchema,
  argv: z.array(z.string()),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
  oomKilled: z.boolean(),
  createdAt: commandDateSchema,
});

const serializedJobCommandSchema = serializedJobCommandSummarySchema.extend({
  stdout: z.string(),
  stderr: z.string(),
});

/** Converts a command summary into the JSON shape sent to the browser. */
export function serializeJobCommandSummary(
  command: JobCommandSummary,
): SerializedJobCommandSummary {
  return { ...command, createdAt: command.createdAt.toISOString() };
}

/** Converts a command transcript into the JSON shape sent to the browser. */
export function serializeJobCommand(command: JobCommand): SerializedJobCommand {
  return { ...command, createdAt: command.createdAt.toISOString() };
}

/** Validates a JSON command summary and restores its in-memory `Date` value. */
export function parseSerializedJobCommandSummary(value: unknown): JobCommandSummary {
  const parsed = serializedJobCommandSummarySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid job command summary: ${parsed.error.message}`);
  }

  return { ...parsed.data, createdAt: new Date(parsed.data.createdAt) };
}

/** Validates a JSON command transcript and restores its in-memory `Date` value. */
export function parseSerializedJobCommand(value: unknown): JobCommand {
  const parsed = serializedJobCommandSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid job command: ${parsed.error.message}`);
  }

  return { ...parsed.data, createdAt: new Date(parsed.data.createdAt) };
}
