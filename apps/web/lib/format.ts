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

const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? usdFormatter.format(parsed) : value;
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

/** `https://github.com/acme/widgets` -> `github.com/acme/widgets`, for dense table cells. */
export function shortenRepoUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}
