import type { FailureCategory } from "@rivet/contracts";

/**
 * Why a run ended, and what should happen next.
 *
 * One classification function feeds two different systems, which is the reason
 * it lives here rather than in the worker. Postgres needs a `failure_category`
 * to persist and a status to move to; BullMQ needs to know whether to retry the
 * message. Getting those two answers from a single `classify()` is what stops
 * them drifting into disagreeing about the same error.
 */

/** A named error, so `classify` never has to match on message text. */
abstract class JobRunError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Another worker owns this job now.
 *
 * Raised when a heartbeat comes back `null`: the lease was reclaimed while this
 * worker was busy. The only correct response is to stop touching the job
 * entirely - not to fail it, not to release it, not even to log an event
 * against it. Its replacement is mid-flight and every write from here is a
 * write into someone else's job.
 */
export class LeaseLostError extends JobRunError {}

/** A cancel was requested and the worker noticed it between phases. */
export class JobCancelledError extends JobRunError {}

/** `maxDurationSeconds` elapsed. Not a failure of the code, a failure to finish. */
export class JobTimedOutError extends JobRunError {}

/** The worker is shutting down cleanly and is handing the job back. */
export class WorkerShuttingDownError extends JobRunError {}

/**
 * A ceiling from PRD §17 was reached: turns, tool calls, model calls, or spend.
 *
 * Its own outcome rather than a terminal failure, because `budget_exceeded` is
 * a status in its own right and has been since Milestone 0 - a job that ran out
 * of budget did not go wrong, it was stopped, and the difference is worth a
 * distinct status on the dashboard. It never retries: a second attempt would
 * start from zero and spend the same budget reaching the same ceiling.
 *
 * `which` is on the error rather than only in the event because the processor
 * writes `failure_reason` from the message and the phase has already written
 * the structured `agent.budget_exceeded` row by the time this is thrown.
 */
export class BudgetExceededError extends JobRunError {
  constructor(
    message: string,
    readonly which: "cost" | "model_calls" | "tool_calls" | "turns",
  ) {
    super(message);
  }
}

/**
 * Something went wrong that a fresh attempt might get past.
 *
 * Carries a category for the same reason `TerminalJobError` does: the retry
 * path releases the job rather than failing it, so the category is not written
 * to `failure_category` at the moment it is raised - but the error still knows
 * what kind of failure it is, and a retryable error whose attempts run out
 * deserves better than `unknown`.
 */
export class RetryableJobError extends JobRunError {
  constructor(
    message: string,
    readonly category: FailureCategory = "unknown",
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Something went wrong that a fresh attempt would hit again. */
export class TerminalJobError extends JobRunError {
  constructor(
    message: string,
    readonly category: FailureCategory = "unknown",
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * The session ended cleanly and the diff is empty.
 *
 * Terminal, and it is the most interesting failure Milestone 5 can surface: a
 * model that reported `completed` while changing nothing did not do the task
 * while believing it had, and a second attempt starts from the same repository
 * with the same prompt. Failing it loudly is the point - an M5 that can only
 * report success has not validated anything.
 *
 * Terminal rather than retryable is also what keeps `no_changes_produced`
 * readable on the dashboard: it names a bad session, not a bad ten minutes.
 */
export class NoChangesProducedError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "no_changes_produced", options);
  }
}

/**
 * The suite disagrees with the session: a green suite went red, or a red one
 * stayed red.
 *
 * Terminal, and deliberately so at M5. Re-running a whole model session on the
 * chance of better sampling costs another container, another clone and another
 * bill to find out whether the sampling was the problem, and M6 is where
 * resumption gets designed properly. Rivet checks the answer once; the
 * debugging loop belongs to the session's own `bash` turns.
 */
export class ValidationFailedError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "validation_failed", options);
  }
}

/** A checkpoint exceeded the complete-payload bound and cannot be truncated. */
export class CheckpointTooLargeError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "checkpoint_too_large", options);
  }
}

/** A checkpoint cannot be trusted because its durable representation is invalid. */
export class CheckpointCorruptError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "checkpoint_corrupt", options);
  }
}

export type FailureClass =
  | "retryable"
  | "terminal"
  | "cancelled"
  | "timed_out"
  | "budget_exceeded"
  | "lease_lost"
  | "shutting_down";

/**
 * Sorts an error into one of the six outcomes the processor knows how to handle.
 *
 * The default matters more than any of the explicit cases: **an unrecognised
 * error is terminal, not retryable.** Retrying an error nobody has reasoned
 * about is how a bug becomes three identical bugs, a tripled bill, and a
 * timeline that is three times as hard to read. Retryability is a claim about an
 * error, and a claim has to be made deliberately by throwing
 * `RetryableJobError`.
 */
export function classify(error: unknown): FailureClass {
  if (error instanceof LeaseLostError) return "lease_lost";
  if (error instanceof WorkerShuttingDownError) return "shutting_down";
  if (error instanceof JobCancelledError) return "cancelled";
  if (error instanceof JobTimedOutError) return "timed_out";
  if (error instanceof BudgetExceededError) return "budget_exceeded";
  if (error instanceof RetryableJobError) return "retryable";
  return "terminal";
}

/**
 * The `failure_category` column value for a classified error.
 *
 * `lease_lost` and `shutting_down` are absent on purpose: neither writes to the
 * job at all, so neither has a category to persist.
 */
export function failureCategoryFor(error: unknown): FailureCategory {
  switch (classify(error)) {
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    case "budget_exceeded":
      return "budget_exceeded";
    case "terminal":
      return error instanceof TerminalJobError ? error.category : "unknown";
    case "retryable":
      return error instanceof RetryableJobError ? error.category : "unknown";
    default:
      return "unknown";
  }
}

/** A one-line description safe to persist in `failure_reason`. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
