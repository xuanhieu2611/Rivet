"use client";

import { isTerminal, type JobStatus } from "@rivet/contracts";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * TODO(M3): delete when SSE lands.
 *
 * The job detail page is server-rendered, so without something asking for it
 * again a running job looks frozen. This asks - `router.refresh()` re-runs the
 * server component and reconciles the result into the existing tree, so the
 * status badge and the timeline update without a navigation and without losing
 * scroll position.
 *
 * It stops itself at a terminal status: there is nothing further to see, and a
 * dashboard left open overnight should not keep both Neon and this component
 * awake. Milestone 3 replaces the whole thing with an event stream, which is
 * why it stays this small rather than growing backoff and visibility handling.
 */
const POLL_INTERVAL_MS = 2_000;

export function JobStatusPoller({ status }: { status: JobStatus }) {
  const router = useRouter();

  useEffect(() => {
    if (isTerminal(status)) return;

    const timer = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
    // `status` is a dependency so the loop is torn down by the render that first
    // shows a terminal status, rather than surviving until the page unmounts.
  }, [status, router]);

  return null;
}
