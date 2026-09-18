"use client";

import { CountUp } from "@/components/count-up";
import { formatAgentCost, formatTokenCount } from "@/lib/format";

import { useJobLive } from "./job-live-provider";

/**
 * Live model usage counters for the job header.
 *
 * The three numbers only ever move upward and only while a session is running,
 * which is exactly the case a hard swap wastes: a token total that jumps from
 * 12,400 to 18,900 between two paints says nothing about which of the two it
 * settled on, while one that travels there is unmistakably still climbing. The
 * cost is counted as a number and reformatted per frame rather than
 * interpolated as a string, because the persisted total is `numeric(10,4)` and
 * the display must keep all four places at every step.
 */
export function LiveAgentUsage() {
  const { usage, timelineMotion } = useJobLive();
  const animate = !timelineMotion.reduceMotion;
  const cost = Number(usage.costUsd);

  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
      aria-live="polite"
      aria-label="Coding agent usage"
      data-agent-usage
    >
      <span>
        <span className="mr-1">In</span>
        <CountUp
          value={usage.inputTokens}
          format={formatTokenCount}
          animate={animate}
          className="text-foreground font-mono tabular-nums"
        />
      </span>
      <span>
        <span className="mr-1">Out</span>
        <CountUp
          value={usage.outputTokens}
          format={formatTokenCount}
          animate={animate}
          className="text-foreground font-mono tabular-nums"
        />
      </span>
      <span title={usage.costKnown ? undefined : "The provider did not report a computable cost."}>
        <span className="mr-1">Cost</span>
        {usage.costKnown && Number.isFinite(cost) ? (
          <CountUp
            value={cost}
            format={formatCountedCost}
            animate={animate}
            className="text-foreground font-mono tabular-nums"
          />
        ) : (
          <span className="text-foreground font-mono tabular-nums">
            {usage.costKnown ? formatAgentCost(usage.costUsd) : "unpriced"}
          </span>
        )}
      </span>
    </div>
  );
}

/** Four decimal places on every frame, the same shape the persisted total has. */
function formatCountedCost(value: number): string {
  return formatAgentCost(value.toFixed(4));
}
