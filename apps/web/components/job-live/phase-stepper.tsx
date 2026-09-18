"use client";

import { AnimatePresence, motion } from "motion/react";
import { useMemo } from "react";

import { formatCommandDuration } from "@/lib/format";
import { statusLabel } from "@/lib/job-status";
import { cn } from "@/lib/utils";

import { useJobLive } from "./job-live-provider";
import { derivePhaseProgress, type PhaseSegment, type PhaseSegmentState } from "./phase-progress";

const SEGMENT_FILL_TRANSITION = { duration: 0.45, ease: [0.23, 1, 0.32, 1] } as const;

/**
 * How long the newly active segment waits before it starts filling.
 *
 * An advance is one phase finishing and the next starting, and the two are
 * legible as a handoff only if they happen in that order. Playing both at once
 * reads as the whole bar twitching. The delay costs nothing on load, because
 * mount is not animated at all.
 */
const SEGMENT_HANDOFF_DELAY = 0.3;

const SEGMENT_FILL_WIDTH: Record<PhaseSegmentState, string> = {
  pending: "0%",
  active: "55%",
  complete: "100%",
};

const STATUS_SWAP_TRANSITION = { duration: 0.22, ease: [0.23, 1, 0.32, 1] } as const;

/**
 * Where the run is, as seven segments.
 *
 * Derived entirely from the live reducer - the same durable events the timeline
 * renders - so it needs no second data path and no polling. Reading the log is
 * how you would otherwise answer "how far along is this", and reading a log is
 * work.
 *
 * Every fill is `initial={false}`: opening a job that is already four phases in
 * paints those four filled and still, and only an advance that happens while
 * somebody is watching moves. Replaying a run's history as animation on every
 * load would make a page refresh indistinguishable from progress, which is the
 * one thing this component exists to tell apart.
 */
export function PhaseStepper() {
  const { events, status, timelineMotion } = useJobLive();
  const progress = useMemo(() => derivePhaseProgress(events, status), [events, status]);

  if (progress.terminal) {
    return <TerminalSummary />;
  }

  const { segments, completedCount, revisions } = progress;
  const animate = !timelineMotion.reduceMotion;

  return (
    <section aria-label="Pipeline progress" className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-muted-foreground text-xs">
          <Swap
            value={statusLabel(status)}
            animate={animate}
            className="text-foreground font-medium"
          />
          {status === "queued" ? " · waiting for a worker" : null}
          {revisions > 0 ? (
            <span className="text-amber-700 dark:text-amber-300">
              {` · revision ${String(revisions)}`}
            </span>
          ) : null}
        </p>
        <p className="text-muted-foreground text-xs tabular-nums">
          <Swap value={String(completedCount)} animate={animate} /> of {segments.length} phases
        </p>
      </div>

      <ol className="flex items-stretch gap-1.5">
        {segments.map((segment) => (
          <li key={segment.status} className="min-w-0 flex-1">
            <Segment
              segment={segment}
              revisions={segment.status === "implementing" ? revisions : 0}
              animate={animate}
              pulse={timelineMotion.pulseActive}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * One short string replacing another, rolling upward.
 *
 * Used for the phase word and for the completed count, which are the two pieces
 * of text an advance changes. Neither is a quantity worth tweening - the count
 * moves by exactly one and a fractional phase means nothing - so the motion is
 * a swap in the direction the stepper travels rather than a counter.
 */
function Swap({
  value,
  animate,
  className,
}: {
  value: string;
  animate: boolean;
  className?: string;
}) {
  if (!animate) {
    return <span className={className}>{value}</span>;
  }

  return (
    <span className="relative inline-flex">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={value}
          className={className}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={STATUS_SWAP_TRANSITION}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
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
  const width = SEGMENT_FILL_WIDTH[segment.state];

  return (
    <div className="group/segment space-y-1.5" title={title} data-phase-state={segment.state}>
      <div className="bg-muted relative h-1 w-full overflow-hidden rounded-full">
        {animate ? (
          <motion.span
            className={cn(
              "absolute inset-y-0 left-0 overflow-hidden rounded-full",
              segment.state === "complete" ? "bg-primary" : "bg-primary/70",
            )}
            initial={false}
            animate={{ width }}
            transition={{
              ...SEGMENT_FILL_TRANSITION,
              delay: segment.state === "active" ? SEGMENT_HANDOFF_DELAY : 0,
            }}
          >
            {/*
             * A sweep rather than a throb, and inside the fill rather than
             * over the whole segment. An opacity pulse on a four-pixel bar is
             * barely visible and reads as a rendering glitch; a highlight
             * travelling left to right says work is moving through here, and
             * points the same direction the stepper advances. Over the unfilled
             * remainder it would instead draw progress that has not happened.
             */}
            {segment.state === "active" && pulse ? (
              <motion.span
                aria-hidden
                className="via-primary-foreground/45 absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent to-transparent"
                initial={{ x: "-100%" }}
                animate={{ x: ["-100%", "300%"] }}
                transition={{
                  duration: 1.6,
                  repeat: Infinity,
                  repeatDelay: 0.5,
                  ease: "easeInOut",
                  delay: SEGMENT_HANDOFF_DELAY,
                }}
              />
            ) : null}
          </motion.span>
        ) : (
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              segment.state === "complete" ? "bg-primary" : "bg-primary/70",
            )}
            style={{ width }}
          />
        )}
      </div>

      <p
        className={cn(
          "truncate text-[11px] leading-tight transition-colors duration-300 motion-reduce:transition-none",
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
