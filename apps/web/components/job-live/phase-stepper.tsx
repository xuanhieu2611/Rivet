"use client";

import { motion } from "motion/react";
import { useMemo } from "react";

import { formatCommandDuration } from "@/lib/format";
import { statusLabel } from "@/lib/job-status";
import { cn } from "@/lib/utils";

import { useJobLive } from "./job-live-provider";
import { derivePhaseProgress, type PhaseSegment } from "./phase-progress";

const SEGMENT_FILL_TRANSITION = { duration: 0.45, ease: [0.23, 1, 0.32, 1] } as const;

/**
 * Where the run is, as seven segments.
 *
 * Derived entirely from the live reducer - the same durable events the timeline
 * renders - so it needs no second data path and no polling. Reading the log is
 * how you would otherwise answer "how far along is this", and reading a log is
 * work.
 */
export function PhaseStepper() {
  const { events, status, timelineMotion } = useJobLive();
  const progress = useMemo(() => derivePhaseProgress(events, status), [events, status]);

  if (progress.terminal) {
    return <TerminalSummary />;
  }

  const { segments, completedCount, revisions } = progress;

  return (
    <section aria-label="Pipeline progress" className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-muted-foreground text-xs">
          <span className="text-foreground font-medium">{statusLabel(status)}</span>
          {status === "queued" ? " · waiting for a worker" : null}
          {revisions > 0 ? (
            <span className="text-amber-700 dark:text-amber-300">
              {` · revision ${String(revisions)}`}
            </span>
          ) : null}
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          {completedCount} of {segments.length} phases
        </p>
      </div>

      <ol className="flex items-stretch gap-1.5">
        {segments.map((segment) => (
          <li key={segment.status} className="min-w-0 flex-1">
            <Segment
              segment={segment}
              revisions={segment.status === "implementing" ? revisions : 0}
              animate={!timelineMotion.reduceMotion}
              pulse={timelineMotion.pulseActive}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Segment({
  segment,
  revisions,
  animate,
  pulse,
}: {
  segment: PhaseSegment;
  revisions: number;
  animate: boolean;
  pulse: boolean;
}) {
  const elapsed = segment.durationMs === null ? null : formatCommandDuration(segment.durationMs);
  const title = [
    segment.label,
    elapsed ? `took ${elapsed}` : segment.state === "active" ? "running" : "not reached",
    segment.visits > 1 ? `${String(segment.visits)} visits` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <div className="group/segment space-y-1.5" title={title} data-phase-state={segment.state}>
      <div className="bg-muted relative h-1 w-full overflow-hidden rounded-full">
        {segment.state === "pending" ? null : animate ? (
          <motion.span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              segment.state === "complete" ? "bg-primary" : "bg-primary/70",
            )}
            initial={{ width: "0%" }}
            animate={{ width: segment.state === "complete" ? "100%" : "55%" }}
            transition={SEGMENT_FILL_TRANSITION}
          />
        ) : (
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              segment.state === "complete" ? "w-full bg-primary" : "w-[55%] bg-primary/70",
            )}
          />
        )}

        {segment.state === "active" && animate && pulse ? (
          <motion.span
            aria-hidden
            className="bg-primary/30 absolute inset-y-0 left-0 w-full rounded-full"
            animate={{ opacity: [0.15, 0.5, 0.15] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : null}
      </div>

      <p
        className={cn(
          "truncate text-[11px] leading-tight",
          segment.state === "active"
            ? "text-foreground font-medium"
            : segment.state === "complete"
              ? "text-muted-foreground"
              : "text-muted-foreground/50",
        )}
      >
        {segment.label}
        {revisions > 0 ? (
          <span className="text-amber-700 dark:text-amber-300">{` ×${String(revisions + 1)}`}</span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * The collapsed form.
 *
 * A finished run has a result header above it saying what came of the job, so
 * the stepper's remaining job is the one thing that header cannot say: which
 * phase the run reached, and how long the phases took.
 */
function TerminalSummary() {
  const { events, status } = useJobLive();
  const progress = useMemo(() => derivePhaseProgress(events, status), [events, status]);
  const total =
    progress.totalDurationMs === null ? null : formatCommandDuration(progress.totalDurationMs);
  const stopped = progress.segments.find((segment) => segment.status === progress.lastPhase);

  return (
    <p className="text-muted-foreground text-xs" aria-label="Pipeline progress">
      <span className="text-foreground font-medium">{statusLabel(status)}</span>
      {` · ${String(progress.completedCount)} of ${String(progress.segments.length)} phases`}
      {status === "completed" || stopped === undefined
        ? null
        : ` · stopped at ${stopped.label.toLowerCase()}`}
      {total === null ? null : ` · ${total} in phases`}
      {progress.revisions > 0
        ? ` · ${String(progress.revisions)} revision${progress.revisions === 1 ? "" : "s"}`
        : null}
    </p>
  );
}
