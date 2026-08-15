/**
 * Formatting helpers shared by the dashboard and the detail page.
 *
 * Everything renders on the server, so the locale is pinned to `en-US` and the
 * time zone to UTC. An unpinned `toLocaleString` would format differently on the
 * server and in the browser and trip React's hydration check.
 */

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatDateTime(value: Date | null): string {
  if (!value) return "not yet";
  return `${dateTimeFormatter.format(value)} UTC`;
}

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeStyle: "medium",
  timeZone: "UTC",
  hour12: false,
});

/** Second precision, no date: the timeline is always one job on one day. */
export function formatTimeOfDay(value: Date): string {
  return timeFormatter.format(value);
}

const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const preciseUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const tokenFormatter = new Intl.NumberFormat("en-US");

export function formatUsd(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? usdFormatter.format(parsed) : value;
}

/** Formats model token totals without hiding small but meaningful counts. */
export function formatTokenCount(value: number): string {
  return tokenFormatter.format(Math.max(0, Math.round(value)));
}

/** Keeps sub-cent model usage visible in the job header. */
export function formatAgentCost(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? preciseUsdFormatter.format(parsed) : value;
}

/** `3600` -> `"1h 0m"`, `90` -> `"1m 30s"`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remainder = seconds % 60;
    return remainder === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(remainder)}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes === 0
    ? `${String(hours)}h`
    : `${String(hours)}h ${String(remainderMinutes)}m`;
}

/**
 * How long a run has taken so far, or took in total.
 *
 * `now` is passed in rather than read, because this renders on the server: a
 * running job's elapsed time is a snapshot taken when the page was built, and
 * the final stream refresh synchronizes it when the run ends. Taking the clock
 * as an argument keeps that visible at the call site and keeps the function
 * testable.
 */
export function formatElapsed(
  startedAt: Date | null,
  completedAt: Date | null,
  now: Date = new Date(),
): string {
  if (!startedAt) return "not started";
  const end = completedAt ?? now;
  const seconds = Math.max(0, Math.round((end.getTime() - startedAt.getTime()) / 1_000));
  return completedAt ? formatDuration(seconds) : `${formatDuration(seconds)} so far`;
}

/** `850` -> `"850ms"`, `1500` -> `"1.5s"`. */
export function formatCommandDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${String(milliseconds)}ms`;
  const seconds = milliseconds / 1_000;
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
}

/** `1536` -> `"1.5 KB"`. Binary units, because every producer of these counts is a byte length. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(bytes < 10 * 1_024 * 1_024 ? 1 : 0)} MB`;
}

/** `https://github.com/acme/widgets` -> `github.com/acme/widgets`, for dense table cells. */
export function shortenRepoUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}
