"use client";

import { useEffect, useState } from "react";

import { formatDateTime } from "@/lib/format";
import { formatRelativeTime, relativeTimeRefreshMs } from "@/lib/relative-time";

interface RelativeTimeProps {
  value: Date | string | null;
  /** What to render when there is no instant at all. */
  fallback?: string;
  className?: string;
}

/**
 * An absolute instant that becomes a relative one after hydration.
 *
 * `formatDateTime` pins `en-US` and UTC so the server and the browser agree,
 * which is the correct engineering decision with an unfriendly result: every
 * date in the product reads `Sep 17, 2026, 2:03 PM UTC`. This keeps the pinned
 * string as the server output *and* as the first client render - so React's
 * hydration check compares two identical trees - and only the effect afterwards
 * swaps in `4 minutes ago`, with the viewer's own local time moved into
 * `title`. Nothing about this can mismatch, because the upgrade happens after
 * hydration rather than during it.
 */
export function RelativeTime({ value, fallback = "not yet", className }: RelativeTimeProps) {
  const date = toDate(value);
  // A Date is a new object on every render, so the effect below keys on the
  // instant rather than on the object identity.
  const timestamp = date?.getTime() ?? null;
  const absolute = date ? formatDateTime(date) : fallback;
  const [display, setDisplay] = useState<{ label: string; title: string }>({
    label: absolute,
    title: absolute,
  });

  useEffect(() => {
    if (timestamp === null) return;
    const instant = new Date(timestamp);

    let timer: number | undefined;

    const tick = () => {
      const now = new Date();
      const relative = formatRelativeTime(instant, now);
      setDisplay({
        label: relative ?? formatDateTime(instant),
        // The exact instant is still one hover away, now in the reader's own
        // time zone rather than in UTC.
        title: localDateTime(instant),
      });
      timer = window.setTimeout(tick, relativeTimeRefreshMs(instant, now));
    };

    tick();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [timestamp]);

  if (!date) {
    return <span className={className}>{fallback}</span>;
  }

  return (
    <time dateTime={date.toISOString()} title={display.title} className={className}>
      {display.label}
    </time>
  );
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Runs only inside the effect, so an unpinned locale cannot reach the server. */
function localDateTime(value: Date): string {
  return value.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
