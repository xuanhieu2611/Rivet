"use client";

import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { useJobLive } from "./job-live-provider";
import type { StreamConnectionState } from "./stream-state";

const CONNECTION_PRESENTATION: Record<
  StreamConnectionState,
  { label: string; dotClassName: string; textClassName: string }
> = {
  connecting: {
    label: "Connecting",
    dotClassName: "bg-amber-500",
    textClassName: "text-muted-foreground",
  },
  live: {
    label: "Live",
    dotClassName: "bg-emerald-500",
    textClassName: "text-emerald-700 dark:text-emerald-300",
  },
  reconnecting: {
    label: "Reconnecting",
    dotClassName: "bg-amber-500",
    textClassName: "text-amber-700 dark:text-amber-300",
  },
  finished: {
    label: "Finished",
    dotClassName: "bg-muted-foreground/50",
    textClassName: "text-muted-foreground",
  },
};

/** A status badge backed by the reducer rather than the server snapshot. */
export function LiveStatusBadge() {
  const { status } = useJobLive();
  return (
    <span aria-live="polite">
      <StatusBadge status={status} />
    </span>
  );
}

/** Small accessible transport state for the job timeline header. */
export function LiveConnectionIndicator() {
  const { connection } = useJobLive();
  const presentation = CONNECTION_PRESENTATION[connection];

  return (
    <Badge
      variant="outline"
      data-connection={connection}
      role="status"
      aria-live="polite"
      className={presentation.textClassName}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${presentation.dotClassName}`} />
      {presentation.label}
    </Badge>
  );
}
