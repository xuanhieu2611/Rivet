import type { FailureCategory } from "@rivet/contracts";

import { RetryableJobError, TerminalJobError } from "../jobs/failure";

/**
 * The ways a coding session can fail a job.
 *
 * Two categories, and the split is the retry decision rather than a description
 * of it: where an error sits in this hierarchy *is* what `classify()` reads, so
 * the reasoning happens once, here, next to the case it applies to, instead of
 * in a lookup table that can quietly come to disagree.
 *
 * Note what is deliberately absent. A tool that failed is not here, because a
 * failed tool is a result the model reads and reacts to - that is the loop
 * working, not a job ending. A budget ceiling is not here either: it lives in
 * `jobs/failure.ts` with the other run outcomes, because it produces its own
 * terminal status rather than a failure category.
 */

/**
 * The model provider could not be reached, or refused for a reason that may
 * pass: a 429, a 5xx, a dropped connection.
 *
 * Retryable, and it is the one failure in this system whose cause is a third
 * party's bad ten minutes. The sweeper will hand the job to whichever worker
 * tries next, by which time the provider has usually recovered.
 */
export class AgentUnavailableError extends RetryableJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "agent_unavailable", options);
  }
}

/**
 * The session cannot run as configured: a rejected key, a model id the provider
 * does not have, a harness that came up holding the wrong tools.
 *
 * Terminal, because every one of those fails identically on the second attempt
 * while spending another container and another clone to find out. The
 * wrong-tools case is the one worth stating out loud: it is not a transient
 * fault at all, it is the containment assertion refusing to run a model that
 * would have had capabilities Rivet cannot see.
 */
export class AgentFailedError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "agent_failed", options);
  }
}

/**
 * The session outlived its own deadline, which is not the job outliving its
 * budget.
 *
 * Kept apart from `JobTimedOutError` for the reason every other pair of
 * deadlines in this system is kept apart: "the job was slow" and "the model
 * stopped making progress" are different facts, they have different fixes, and
 * a timeline that says which one happened is worth the extra class. The status
 * is `failed` rather than `timed_out` because the job's own budget has not been
 * spent; `agent.session_ended` carries `stopReason: "timeout"`, which is where
 * the distinction is actually recorded.
 */
export class AgentSessionTimedOutError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "agent_failed", options);
  }
}

/** The planner ended without submitting a valid structured plan. */
export class PlanNotProducedError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "plan_not_produced", options);
  }
}

/** The categories this layer raises, for the tests that prove the table in the docs. */
export const AGENT_FAILURE_CATEGORIES = [
  "agent_unavailable",
  "agent_failed",
  "plan_not_produced",
] as const satisfies readonly FailureCategory[];
