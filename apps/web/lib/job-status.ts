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
    className: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  analyzing: {
    label: "Analyzing",
    className: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  planning: {
    label: "Planning",
    className: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
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
  "job.claimed": "bg-violet-500",
  "job.status_changed": "bg-sky-500",
  "phase.started": "bg-sky-500",
  "phase.completed": "bg-sky-500/40",
  "job.cancel_requested": "bg-amber-500",
  "job.retry_scheduled": "bg-amber-500",
  "job.reclaimed": "bg-amber-500",
  "job.lease_lost": "bg-amber-500",
  "job.failed": "bg-red-500",
  "job.completed": "bg-emerald-500",
  "sandbox.created": "bg-violet-500",
  "sandbox.destroyed": "bg-muted-foreground/40",
  "repo.cloned": "bg-sky-500",
  "deps.installed": "bg-sky-500",
  "command.completed": "bg-sky-500/40",
  "baseline.recorded": "bg-sky-500",
};
