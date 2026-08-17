import {
  FAILURE_CATEGORIES,
  type FailureCategory,
  type FailureLabel,
  type FailureLabelSource,
  type JobStatus,
  type ReviewDecision,
  type RunResult,
} from "@rivet/contracts";

/**
 * Which side of the success rate a job's ending falls on, decided once.
 *
 * An evaluation harness fails by producing a number that is wrong in a way
 * nobody notices, and the cheapest way to produce one here is to average an
 * infrastructure failure rate into a task failure rate. A Docker daemon that
 * died is not a model that could not fix a bug; reporting them as one number
 * hides both.
 *
 * So the classification is a total `Record` over `FAILURE_CATEGORIES` rather
 * than an array of the interesting ones. A category added in a later milestone
 * fails `pnpm typecheck` here until somebody decides which side of the success
 * rate it belongs on, which is the whole point: an unclassified category
 * silently defaulting either way is exactly the leak this file exists to stop.
 */
export type EvaluationFailureClass = "infrastructure" | "task";

/**
 * The complete classification, and the judgement calls are recorded as such.
 *
 * `command_timed_out` is a task failure: a command that blew its own budget is
 * usually the model writing a script that hangs, which is a statement about the
 * work. The job blowing `max_duration_seconds` is `timed_out` and is on the
 * other side. `unsupported_project` and `validation_config_invalid` are
 * infrastructure because they are facts about the repository Rivet was pointed
 * at rather than about the change it was asked to make - a benchmark case that
 * trips either one is a broken case, and scoring a model zero for it would be
 * the same category of lie as grading a tampered tree.
 */
export const EVALUATION_FAILURE_CLASSES = {
  worker_crash: "infrastructure",
  lease_expired: "infrastructure",
  timed_out: "infrastructure",
  budget_exceeded: "infrastructure",
  cancelled: "infrastructure",

  sandbox_unavailable: "infrastructure",
  sandbox_create_failed: "infrastructure",
  repo_unavailable: "infrastructure",
  unsupported_project: "infrastructure",
  dependency_install_failed: "infrastructure",
  command_timed_out: "task",
  oom_killed: "infrastructure",
  sandbox_leaked: "infrastructure",

  agent_unavailable: "infrastructure",
  agent_failed: "infrastructure",

  no_changes_produced: "task",
  validation_failed: "task",
  validation_config_invalid: "infrastructure",

  plan_not_produced: "task",
  checkpoint_corrupt: "infrastructure",
  checkpoint_restore_failed: "infrastructure",
  checkpoint_too_large: "infrastructure",

  review_not_produced: "task",
  reviewer_rejection: "task",

  github_unavailable: "infrastructure",
  github_permission_denied: "infrastructure",
  push_rejected: "infrastructure",
  pull_request_failed: "infrastructure",
  github_not_installed: "infrastructure",

  unknown: "infrastructure",
} as const satisfies Record<FailureCategory, EvaluationFailureClass>;

/**
 * Every category is classified, in both directions and at compile time.
 *
 * `satisfies` refuses a missing key; the object literal's own excess-property
 * check refuses an invented one. The alias is what other modules read, so a
 * caller cannot end up holding a wider category type than this file classifies.
 */
export type ClassifiedFailureCategory = keyof typeof EVALUATION_FAILURE_CLASSES;

/** The runtime half of the same assertion, for a test that can print the gap. */
export const CLASSIFIED_FAILURE_CATEGORIES: readonly ClassifiedFailureCategory[] =
  FAILURE_CATEGORIES;

/** The facts about a finished job that decide how its evaluation run is scored. */
export interface JobOutcomeFacts {
  status: JobStatus;
  failureCategory: FailureCategory | null;
  /** `jobs.failure_reason`, used only to tell a tool assertion from other agent failures. */
  failureReason?: string | null;
  /** `jobs.review_decision`, null when no reviewer looked at the job. */
  reviewDecision?: ReviewDecision | null;
  /** True when the implementing session stopped because it ran out of turns. */
  turnCeilingReached?: boolean;
  /** From the `diff_stat` artifact; null when the job produced no diff at all. */
  filesChanged?: number | null;
}

/**
 * Whether a job can be judged at all, decided from the job row and nothing else.
 *
 * The ordering in the acceptance contract is the contract: a job is classified
 * *before* grading is attempted, so a job that failed in `provisioning` never
 * reaches the question of whether its (nonexistent) workspace could be graded.
 * `ungraded` is reserved for a job that could have been graded and whose
 * grading broke. Conflating the two puts Docker outages in the same bucket as
 * harness bugs.
 */
export function isErroredOutcome(job: JobOutcomeFacts): boolean {
  if (job.status === "cancelled") return true;
  if (!isTerminalFailure(job.status)) return false;
  const category = job.failureCategory;
  if (category === null) return true;
  return EVALUATION_FAILURE_CLASSES[category] === "infrastructure";
}

/** Terminal statuses that mean the job did not finish its work. */
function isTerminalFailure(status: JobStatus): boolean {
  return (
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out" ||
    status === "budget_exceeded"
  );
}

/**
 * The substring the harness's own tool assertion puts in a failure reason.
 *
 * Coupled to `PiCodingAgent`'s message on purpose, and cheaply: a tool
 * assertion and a rejected API key are both `agent_failed`, and telling them
 * apart is the difference between "Rivet's harness is broken" and "this
 * machine's credentials are". The coupling is one string in one direction, and
 * getting it wrong costs a label rather than a result.
 */
export const TOOL_ASSERTION_MARKER = "session came up holding";

/** True when an `agent_failed` job failed the exposed-tool assertion. */
export function isToolAssertionFailure(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.includes(TOOL_ASSERTION_MARKER);
}

/** A derived §24.5 label, or nothing when the call is not machine-decidable. */
export interface AutoFailureLabel {
  label: FailureLabel;
  source: FailureLabelSource;
}

/**
 * Derives a §24.5 label where the data decides it, and refuses to guess.
 *
 * `Incorrect diagnosis`, `Insufficient context`, `Bad implementation` and
 * `Test misunderstanding` are deliberately absent. They are not machine
 * decidable, and a classifier that guessed them would produce a failure
 * histogram that looks rigorous and is fiction. `pnpm eval:label` is where a
 * person supplies those, and the stored source column is what keeps a chart
 * from mixing derived and human labels without saying so.
 */
export function autoFailureLabel(job: JobOutcomeFacts, result: RunResult): AutoFailureLabel | null {
  if (result === "passed") return null;

  const category = job.failureCategory;
  if (category === "budget_exceeded" || job.status === "budget_exceeded") {
    return { label: "Budget exceeded", source: "auto" };
  }
  if (category === "agent_failed" && isToolAssertionFailure(job.failureReason)) {
    return { label: "Tool failure", source: "auto" };
  }
  // A cancelled job is a person changing their mind, not a failure mode of the
  // system under test, so it keeps the null label the taxonomy has no word for.
  if (job.status !== "cancelled" && category !== null && category !== "cancelled") {
    if (EVALUATION_FAILURE_CLASSES[category] === "infrastructure") {
      return { label: "Environment failure", source: "auto" };
    }
  }
  if (result === "failed" && job.reviewDecision === "approve") {
    // The reviewer looked at a change that does not do what the issue asked and
    // said yes. That is the one review metric worth counting.
    return { label: "Reviewer false positive", source: "auto" };
  }
  if (result === "failed" && job.turnCeilingReached === true && (job.filesChanged ?? 0) === 0) {
    return { label: "Agent loop", source: "auto" };
  }

  return null;
}
