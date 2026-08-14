"use client";

import { formatAgentCost, formatTokenCount } from "@/lib/format";

import { useJobLive } from "./job-live-provider";

/** Live model usage counters for the job header. */
export function LiveAgentUsage() {
  const { usage } = useJobLive();

  return (
    <div
      className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
      aria-live="polite"
      aria-label="Coding agent usage"
      data-agent-usage
    >
      <span>
        <span className="mr-1">In</span>
        <span className="text-foreground font-mono tabular-nums">
          {formatTokenCount(usage.inputTokens)}
        </span>
      </span>
      <span>
        <span className="mr-1">Out</span>
        <span className="text-foreground font-mono tabular-nums">
          {formatTokenCount(usage.outputTokens)}
        </span>
      </span>
      <span title={usage.costKnown ? undefined : "The provider did not report a computable cost."}>
        <span className="mr-1">Cost</span>
        <span className="text-foreground font-mono tabular-nums">
          {usage.costKnown ? formatAgentCost(usage.costUsd) : "unpriced"}
        </span>
      </span>
    </div>
  );
}
