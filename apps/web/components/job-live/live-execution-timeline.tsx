"use client";

import { ExecutionTimeline } from "@/components/execution-timeline";

import { useJobLive } from "./job-live-provider";

/** Renders the same timeline presentation against the live reducer state. */
export function LiveExecutionTimeline() {
  const { events } = useJobLive();

  return (
    <div aria-live="polite" aria-relevant="additions">
      <ExecutionTimeline events={events} />
    </div>
  );
}
