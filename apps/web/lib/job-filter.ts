import { JOB_STATUSES, TERMINAL_STATUSES, type JobStatus } from "@rivet/contracts";

export const JOB_FILTERS = ["all", "running", "completed", "failed"] as const;

export type JobFilter = (typeof JOB_FILTERS)[number];

export const DEFAULT_JOB_FILTER: JobFilter = "all";

/**
 * Statuses each tab selects, or null for "do not filter".
 *
 * `running` is defined as "not terminal" rather than as a list of phases, so a
 * status added in a later milestone lands in the right tab without anyone
 * remembering to add it here. The two failure-ish statuses that are not
 * failures - `cancelled`, because somebody asked for it - stay out of `failed`
 * and remain visible under `all`.
 */
export const JOB_FILTER_STATUSES: Record<JobFilter, readonly JobStatus[] | null> = {
  all: null,
  running: JOB_STATUSES.filter((status) => !TERMINAL_STATUSES.has(status)),
  completed: ["completed"],
  failed: ["failed", "budget_exceeded", "timed_out"],
};

export const JOB_FILTER_LABELS: Record<JobFilter, string> = {
  all: "All",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

/**
 * Reads the tab out of the URL.
 *
 * The filter lives in the query string rather than in client state so a
 * filtered view is linkable and the page stays a server component - which is
 * also what keeps `force-dynamic` meaning what it means. Anything unrecognised
 * falls back to `all`; a dashboard is not worth a 400.
 */
export function parseJobFilter(value: string | string[] | undefined): JobFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  return JOB_FILTERS.find((filter) => filter === raw) ?? DEFAULT_JOB_FILTER;
}

/** The `?status=` value for a tab, omitted for the default so `/jobs` stays clean. */
export function jobFilterHref(filter: JobFilter): string {
  return filter === DEFAULT_JOB_FILTER ? "/jobs" : `/jobs?status=${filter}`;
}

/** What `listJobs` should be given for a tab. */
export function jobFilterStatuses(filter: JobFilter): readonly JobStatus[] | undefined {
  return JOB_FILTER_STATUSES[filter] ?? undefined;
}
