const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Past this, relative time stops helping and starts hiding the date.
 *
 * "43 days ago" is harder to act on than the instant itself, so beyond the
 * threshold this returns null and the caller keeps the absolute string it was
 * already rendering.
 */
const MAX_RELATIVE_MS = 30 * DAY;

/**
 * `4 minutes ago`, or null when the absolute time reads better.
 *
 * `now` is an argument rather than a read for the same reason `formatElapsed`
 * takes one: this is called from both a render and an interval, and a function
 * that reads the clock itself cannot be tested without faking it.
 *
 * A small negative difference is ordinary rather than exceptional - a row
 * created a few hundred milliseconds ago against a client clock that is slightly
 * behind the database's is not the future, it is now.
 */
export function formatRelativeTime(value: Date, now: Date): string | null {
  const elapsed = now.getTime() - value.getTime();
  if (!Number.isFinite(elapsed)) return null;
  if (elapsed > MAX_RELATIVE_MS) return null;
  if (elapsed < 45 * SECOND) return elapsed < -MINUTE ? null : "just now";

  if (elapsed < HOUR) return ago(Math.round(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return ago(Math.round(elapsed / HOUR), "hour");
  return ago(Math.round(elapsed / DAY), "day");
}

/** How long until the rendered label could change, so a ticker can be lazy. */
export function relativeTimeRefreshMs(value: Date, now: Date): number {
  const elapsed = Math.max(0, now.getTime() - value.getTime());
  if (elapsed < HOUR) return 15 * SECOND;
  if (elapsed < DAY) return MINUTE;
  return HOUR;
}

function ago(count: number, unit: string): string {
  const whole = Math.max(1, count);
  return `${String(whole)} ${unit}${whole === 1 ? "" : "s"} ago`;
}
