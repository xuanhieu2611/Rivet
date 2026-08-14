import type { JobEvent } from "@rivet/contracts";

export interface InitialAgentUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: string;
}

export interface LiveAgentUsage {
  inputTokens: number;
  outputTokens: number;
  /** The persisted total, plus any priced usage received over SSE. */
  costUsd: string;
  /** False after a provider reports a turn whose cost cannot be computed. */
  costKnown: boolean;
}

/**
 * Extends the persisted usage snapshot with events received after the initial
 * page render. Token usage is per-turn, while the event's cost is cumulative
 * within one session, so priced cost is added by session deltas rather than by
 * adding the cumulative value a second time.
 */
export function deriveLiveAgentUsage(
  initial: InitialAgentUsage,
  initialEvents: readonly JobEvent[],
  events: readonly JobEvent[],
): LiveAgentUsage {
  let inputTokens = nonNegativeInteger(initial.totalInputTokens);
  let outputTokens = nonNegativeInteger(initial.totalOutputTokens);
  let totalCost = parseCost(initial.totalCostUsd);
  let costKnown = totalCost !== null;

  const initialCursor = initialEvents.reduce((cursor, event) => Math.max(cursor, event.id), -1);
  const sessionCosts = new Map<string, number>();

  for (const event of initialEvents) {
    if (event.type !== "agent.usage") continue;
    const cost = event.data?.costUsd;
    if (cost === null) costKnown = false;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      sessionCosts.set(sessionKey(event), Math.max(0, cost));
    }
  }

  for (const event of events) {
    if (event.id <= initialCursor || event.type !== "agent.usage") continue;

    const data = event.data;
    inputTokens += nonNegativeInteger(data?.inputTokens);
    outputTokens += nonNegativeInteger(data?.outputTokens);

    const cost = data?.costUsd;
    if (cost === null) {
      costKnown = false;
      continue;
    }
    if (typeof cost !== "number" || !Number.isFinite(cost)) continue;

    const currentCost = Math.max(0, cost);
    const key = sessionKey(event);
    const previousCost = sessionCosts.get(key);
    const delta =
      previousCost === undefined ? currentCost : Math.max(0, currentCost - previousCost);
    if (totalCost !== null) totalCost += delta;
    sessionCosts.set(key, currentCost);
  }

  return {
    inputTokens,
    outputTokens,
    costUsd: totalCost === null ? initial.totalCostUsd : totalCost.toFixed(4),
    costKnown,
  };
}

function sessionKey(event: JobEvent): string {
  return event.data?.sessionId ?? `event-${String(event.id)}`;
}

function parseCost(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nonNegativeInteger(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}
