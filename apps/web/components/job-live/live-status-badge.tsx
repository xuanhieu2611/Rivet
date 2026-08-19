"use client";

import { AnimatePresence, motion } from "motion/react";

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

const STATUS_ENTER_TRANSITION = {
  duration: 0.2,
  ease: [0.23, 1, 0.32, 1],
} as const;

/** A status badge backed by the reducer rather than the server snapshot. */
export function LiveStatusBadge() {
  const { status, timelineMotion } = useJobLive();

  if (timelineMotion.reduceMotion) {
    return (
      <span aria-live="polite">
        <StatusBadge status={status} className="transition-none" />
      </span>
    );
  }

  return (
    <span aria-live="polite">
      <AnimatePresence initial={false}>
        <motion.span
          key={status}
          className="inline-flex"
          initial={{ opacity: 0, transform: "translateY(4px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
          transition={STATUS_ENTER_TRANSITION}
        >
          <StatusBadge status={status} />
        </motion.span>
      </AnimatePresence>
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
