import type { FailureCategory, JobEventType, JobStatus } from "@rivet/contracts";

/**
 * Presentation metadata for the job lifecycle.
 *
 * Deliberately free of any database or Next.js import: server components, the
 * client-side dev control and the unit tests all read the same table, and it can
 * be bundled for the browser without dragging `pg` along.
 *
 * The `Record<JobStatus, ...>` type is the enforcement mechanism - adding a
 * fifteenth status to the contract breaks `pnpm typecheck` here until it has a
 * label and a colour.
 */
export interface StatusPresentation {
  /** Human-readable label shown in the badge. */
  label: string;
  /** Tailwind classes for the badge surface. One mapping, used everywhere. */
  className: string;
}

export const JOB_STATUS_PRESENTATION: Record<JobStatus, StatusPresentation> = {
  queued: {
    label: "Queued",
    className: "border-border bg-muted text-muted-foreground",
  },
  provisioning: {
    label: "Provisioning",
    className: "border-teal-600/30 bg-teal-500/10 text-teal-800 dark:text-teal-200",
  },
  analyzing: {
    label: "Analyzing",
    className: "border-teal-600/30 bg-teal-500/10 text-teal-800 dark:text-teal-200",
  },
  planning: {
    label: "Planning",
    className: "border-teal-600/30 bg-teal-500/10 text-teal-800 dark:text-teal-200",
  },
  implementing: {
    label: "Implementing",
    className: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  testing: {
    label: "Testing",
    className: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  reviewing: {
    label: "Reviewing",
    className: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  revising: {
    label: "Revising",
    className: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  finalizing: {
    label: "Finalizing",
    className: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  completed: {
    label: "Completed",
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  failed: {
    label: "Failed",
    className: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  cancelled: {
    label: "Cancelled",
    className: "border-border bg-muted text-muted-foreground",
  },
  budget_exceeded: {
    label: "Budget exceeded",
    className: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  timed_out: {
    label: "Timed out",
    className: "border-orange-500/25 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  },
};

export function statusLabel(status: JobStatus): string {
  return JOB_STATUS_PRESENTATION[status].label;
}

/**
 * The failure taxonomy, in words rather than in column values.
 *
 * `failure_category` is a `text` column read back through
 * `parseFailureCategory`, so anything unrecognised has already degraded to
 * `unknown` before it reaches here and this record is total by construction.
 */
export const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  worker_crash: "Worker crash",
  lease_expired: "Lease expired",
  timed_out: "Timed out",
  budget_exceeded: "Budget exceeded",
  cancelled: "Cancelled",
  sandbox_unavailable: "Sandbox unavailable",
  sandbox_create_failed: "Sandbox could not start",
  repo_unavailable: "Repository unavailable",
  unsupported_project: "Unsupported project",
  dependency_install_failed: "Dependency install failed",
  command_timed_out: "Command timed out",
  oom_killed: "Out of memory",
  sandbox_leaked: "Sandbox leaked",
  agent_unavailable: "Agent provider unavailable",
  agent_failed: "Agent failed",
  no_changes_produced: "No changes produced",
  validation_failed: "Validation failed",
  validation_config_invalid: "Validation configuration invalid",
  plan_not_produced: "Plan not produced",
  checkpoint_corrupt: "Checkpoint corrupt",
  checkpoint_restore_failed: "Checkpoint restore failed",
  checkpoint_too_large: "Checkpoint too large",
  review_not_produced: "Review not produced",
  reviewer_rejection: "Rejected by review",
  github_unavailable: "GitHub unavailable",
  github_permission_denied: "GitHub permission denied",
  push_rejected: "Push rejected",
  pull_request_failed: "Pull request failed",
  github_not_installed: "GitHub App not installed",
  unknown: "Unknown",
};

/**
 * Marker colour for each kind of timeline entry.
 *
 * Same enforcement mechanism as the status table above, for the same reason:
 * `JOB_EVENT_TYPES` grows every milestone, and a total `Record` means a new
 * event type breaks `pnpm typecheck` here until someone has decided how it
 * should read. The grouping is by what the reader needs to notice - an ending,
 * something going wrong, something being retried, or ordinary progress - not by
 * which subsystem emitted it.
 */
export const JOB_EVENT_TONE: Record<JobEventType, string> = {
  "job.created": "bg-muted-foreground/40",
  "job.enqueued": "bg-muted-foreground/40",
  "job.enqueue_failed": "bg-amber-500",
  "job.claimed": "bg-teal-500",
  "job.status_changed": "bg-sky-500",
  "phase.started": "bg-sky-500",
  "phase.completed": "bg-sky-500/40",
  "job.cancel_requested": "bg-amber-500",
  "job.retry_scheduled": "bg-amber-500",
  "job.reclaimed": "bg-amber-500",
  "job.lease_lost": "bg-amber-500",
  "job.failed": "bg-red-500",
  "job.completed": "bg-emerald-500",
  "sandbox.created": "bg-teal-500",
  "sandbox.destroyed": "bg-muted-foreground/40",
  "sandbox.resources_recorded": "bg-teal-500",
  "repo.cloned": "bg-sky-500",
  "deps.installed": "bg-sky-500",
  "command.started": "bg-sky-500",
  "command.completed": "bg-sky-500/40",
  "command.failed": "bg-red-500",
  "baseline.check_recorded": "bg-sky-500/40",
  "baseline.recorded": "bg-sky-500",
  // The agent's own entries read as progress, because that is what they are.
  // Only the two that end something get a colour of their own, and a tool call
  // that errored is deliberately not one of them: the model reads the error and
  // tries something else, which is the loop working rather than failing.
  "agent.session_started": "bg-teal-500",
  "agent.turn_started": "bg-sky-500/40",
  "agent.turn_completed": "bg-sky-500/40",
  "agent.message": "bg-sky-500",
  "agent.tool_started": "bg-sky-500",
  "agent.tool_completed": "bg-sky-500/40",
  "agent.usage": "bg-muted-foreground/40",
  "agent.session_ended": "bg-muted-foreground/40",
  "agent.budget_exceeded": "bg-amber-500",
  // A deferred plan is deliberately quiet: it says a phase decided to do
  // nothing, which is the opposite of something the reader needs to notice.
  "plan.deferred": "bg-muted-foreground/40",
  "artifact.recorded": "bg-teal-500",
  "validation.check_recorded": "bg-sky-500/40",
  // Neutral rather than green or red, because the outcome is in the payload:
  // `regressed` and `fixed` are the same event type. Stage 7 colours the row
  // by `data.validation`; the marker only says the comparison happened.
  "validation.recorded": "bg-sky-500",
  // The closing line, and the only entry a reader who scrolled to the bottom
  // needs. Teal rather than green for the same reason `validation.recorded`
  // is not green: this row states an outcome, and `job.completed` is the one
  // that says the outcome was a good one.
  "run.summarized": "bg-teal-500",
  "plan.recorded": "bg-teal-500",
  "checkpoint.created": "bg-teal-500",
  "checkpoint.restored": "bg-emerald-500",
  "checkpoint.rejected": "bg-red-500",
  "run.resumed": "bg-amber-500",
  // Neutral for the same reason `validation.recorded` is neutral: `approve` and
  // `revise` are the same event type and the verdict is in the payload.
  "review.recorded": "bg-teal-500",
  // The row that makes a looping timeline readable. Amber because it is the
  // marker that explains why a second `testing` block follows a first one.
  "review.revision_requested": "bg-amber-500",
  "review.limit_reached": "bg-red-500",
  // A run that asked for no review is not a run whose reviewer said nothing,
  // and the timeline should be quiet about the difference rather than loud.
  "review.skipped": "bg-muted-foreground/40",
  // Publication events are progress markers; their payload carries the
  // branch, receipt, or pull request details shown by the M9 timeline work.
  "github.repository_bound": "bg-teal-500",
  "branch.created": "bg-teal-500",
  "commit.created": "bg-sky-500",
  "push.completed": "bg-emerald-500",
  "pull_request.opened": "bg-emerald-500",
  "pull_request.adopted": "bg-emerald-500",
  "publication.skipped": "bg-muted-foreground/40",
  "external_effect.recorded": "bg-teal-500",
  "security.injection_suspected": "bg-amber-500",
};
