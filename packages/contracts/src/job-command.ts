import type { JobStatus } from "./job";

/**
 * One command executed inside a job's sandbox.
 *
 * A separate table from `job_events` rather than a fat event payload, because
 * the event log is read in full on every timeline render and is supposed to hold
 * small facts. A `pnpm install` transcript is neither. The timeline keeps a
 * command lifecycle, with `command.completed` carrying the `commandId`; the
 * transcript lives one join away and is fetched only when someone opens it.
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
