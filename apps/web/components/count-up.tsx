"use client";

import { useEffect, useRef, useState } from "react";

import { countUpDurationMs, countUpValue } from "@/lib/count-up";

interface CountUpProps {
  value: number;
  /** Applied to every painted frame, so the counter is never briefly unformatted. */
  format: (value: number) => string;
  /** False under `prefers-reduced-motion`, where the value simply swaps. */
  animate?: boolean;
  className?: string;
}

/**
 * A number that travels to its new value instead of swapping to it.
 *
 * The first render returns the value unchanged, which is what keeps this safe
 * inside a server-rendered tree: the server prints the persisted total, the
 * browser's first pass prints the same total, and only a change arriving after
 * hydration is ever animated. Counting up from zero on load would replay a
 * whole run's spend as if it were happening now.
 */
export function CountUp({ value, format, animate = true, className }: CountUpProps) {
  const displayed = useCountUp(value, animate);
  return (
    <span className={className} data-count-up>
      {format(displayed)}
    </span>
  );
}

function useCountUp(value: number, animate: boolean): number {
  const [displayed, setDisplayed] = useState(value);
  // Where the next tween starts. Updated every painted frame, so a value that
  // changes mid-flight continues from what the reader can currently see rather
  // than snapping back to the previous total.
  const fromRef = useRef(value);
  const targetRef = useRef(value);

  useEffect(() => {
    if (targetRef.current === value) return;

    const from = fromRef.current;
    targetRef.current = value;

    const duration = animate ? countUpDurationMs(from, value) : 0;
    if (duration === 0) {
      fromRef.current = value;
      setDisplayed(value);
      return;
    }

    let frame = 0;
    const startedAt = performance.now();

    const step = (now: number) => {
      const elapsed = now - startedAt;
      const next = countUpValue(from, value, elapsed, duration);
      fromRef.current = next;
      setDisplayed(next);
      if (elapsed < duration) frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [animate, value]);

  return displayed;
}
