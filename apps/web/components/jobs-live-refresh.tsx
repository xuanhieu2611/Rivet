"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_INTERVAL_MS = 5_000;

/**
 * Keeps active rows on the jobs list current.
 *
 * The page is `force-dynamic` but nothing ever asks for it again, so a running
 * job's row is stale the moment it renders. This is deliberately a refresh of
 * the server component rather than a second SSE stream: the list needs one
 * column of one table, the detail page already owns the durable-cursor stream,
 * and a per-row EventSource would open one connection per running job to learn
 * a single word.
 *
 * It stops on a page with nothing moving and while the tab is hidden, which is
 * the same rule the job detail stream follows and for the same reason.
 */
export function JobsLiveRefresh({ activeCount }: { activeCount: number }) {
  const router = useRouter();

  useEffect(() => {
    if (activeCount === 0) return;

    let timer: number | undefined;

    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };

    const start = () => {
      if (timer !== undefined || document.visibilityState === "hidden") return;
      timer = window.setInterval(() => {
        router.refresh();
      }, REFRESH_INTERVAL_MS);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      // A tab coming back is showing whatever it had when it left, so it gets
      // one immediate refresh rather than waiting out an interval.
      router.refresh();
      start();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    start();

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [activeCount, router]);

  return null;
}
