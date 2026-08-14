import type { JobEvent } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { deriveLiveAgentUsage } from "./agent-usage";

const JOB_ID = "11111111-2222-3333-4444-555555555555";
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

function usageEvent(id: number, data: NonNullable<JobEvent["data"]>): JobEvent {
  return {
    id,
    jobId: JOB_ID,
    type: "agent.usage",
    message: "usage",
    data,
    createdAt: new Date(CREATED_AT.getTime() + id),
  };
}

describe("deriveLiveAgentUsage", () => {
  it("adds tokens and the cost delta from a live session", () => {
    const initial = usageEvent(10, {
      sessionId: "session-a",
      inputTokens: 1_000,
      outputTokens: 200,
      costUsd: 0.0031,
    });
    const next = usageEvent(11, {
      sessionId: "session-a",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.005,
    });

    expect(
      deriveLiveAgentUsage(
        { totalInputTokens: 1_000, totalOutputTokens: 200, totalCostUsd: "0.0031" },
        [initial],
        [initial, next],
      ),
    ).toEqual({
      inputTokens: 1_100,
      outputTokens: 220,
      costUsd: "0.0050",
      costKnown: true,
    });
  });

  it("adds a new session's cumulative cost once", () => {
    const initial = usageEvent(10, {
      sessionId: "session-a",
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0.001,
    });
    const next = usageEvent(11, {
      sessionId: "session-b",
      inputTokens: 3,
      outputTokens: 4,
      costUsd: 0.002,
    });

    expect(
      deriveLiveAgentUsage(
        { totalInputTokens: 1, totalOutputTokens: 2, totalCostUsd: "0.0010" },
        [initial],
        [initial, next],
      ).costUsd,
    ).toBe("0.0030");
  });

  it("marks cost as unavailable when a live turn is unpriced", () => {
    const initial = usageEvent(10, {
      sessionId: "session-a",
      inputTokens: 1,
      outputTokens: 2,
      costUsd: 0,
    });
    const next = usageEvent(11, {
      sessionId: "session-a",
      inputTokens: 3,
      outputTokens: 4,
      costUsd: null,
    });

    expect(
      deriveLiveAgentUsage(
        { totalInputTokens: 1, totalOutputTokens: 2, totalCostUsd: "0.0000" },
        [initial],
        [initial, next],
      ),
    ).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      costUsd: "0.0000",
      costKnown: false,
    });
  });
});
