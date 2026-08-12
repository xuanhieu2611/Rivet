import { isTerminal, JOB_STATUSES, type JobStatus } from "@rivet/contracts";

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
 * The happy-path lifecycle, in order.
 *
 * TODO(M1): delete when the worker drives transitions. This exists only so the
 * dev-only "Advance status" control has something honest to walk through.
 */
export const HAPPY_PATH_SEQUENCE = [
  "queued",
  "provisioning",
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "revising",
  "finalizing",
  "completed",
] as const satisfies readonly JobStatus[];

/**
 * The next status the dev control should move a job to, or `null` when there is
 * nowhere left to go (terminal statuses, and any status off the happy path).
 *
 * TODO(M1): delete when the worker drives transitions.
 */
export function nextStatus(status: JobStatus): JobStatus | null {
  if (isTerminal(status)) return null;
  const index = (HAPPY_PATH_SEQUENCE as readonly JobStatus[]).indexOf(status);
  if (index === -1) return null;
  return HAPPY_PATH_SEQUENCE[index + 1] ?? null;
}

/** Every status has presentation metadata - asserted by the tests, not just by types. */
export const ALL_JOB_STATUSES: readonly JobStatus[] = JOB_STATUSES;
