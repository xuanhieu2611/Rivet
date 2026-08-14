import { describe, expect, it } from "vitest";

import {
  parseFailureCategory,
  parseSerializedJobEvent,
  serializeJobEvent,
  type JobEvent,
} from "./job-event";

const EVENT: JobEvent = {
  id: 7,
  jobId: "11111111-2222-3333-8444-555555555555",
  type: "phase.completed",
  message: "Testing completed.",
  data: { phase: "testing", durationMs: 1250 },
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("serialized job events", () => {
  it("serializes and restores event dates", () => {
    const serialized = serializeJobEvent(EVENT);

    expect(serialized.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(parseSerializedJobEvent(serialized)).toEqual(EVENT);
  });

  it("rejects malformed ids, dates, and event types", () => {
    expect(() => parseSerializedJobEvent({ ...serializeJobEvent(EVENT), id: 1.5 })).toThrow();
    expect(() =>
      parseSerializedJobEvent({ ...serializeJobEvent(EVENT), createdAt: "not-a-date" }),
    ).toThrow();
    expect(() =>
      parseSerializedJobEvent({ ...serializeJobEvent(EVENT), type: "unknown.event" }),
    ).toThrow();
  });
});

describe("coding agent events", () => {
  const usage: JobEvent = {
    ...EVENT,
    type: "agent.usage",
    message: "Turn 2 used 1,204 tokens.",
    data: { sessionId: "s-1", turn: 2, inputTokens: 980, outputTokens: 224, costUsd: 0.0031 },
  };

  it("round-trips every agent field it claims to know about", () => {
    const started: JobEvent = {
      ...EVENT,
      type: "agent.session_started",
      message: "Session started.",
      data: {
        sessionId: "s-1",
        model: "deepseek/deepseek-v4-flash",
        provider: "openrouter",
        toolNames: ["bash", "edit", "read", "write"],
      },
    };
    const tool: JobEvent = {
      ...EVENT,
      type: "agent.tool_completed",
      message: "bash completed.",
      data: {
        sessionId: "s-1",
        turn: 3,
        toolName: "bash",
        toolCallId: "call-9",
        toolError: true,
        durationMs: 812,
        commandExecutionId: "1f0f2f3f-4f5f-4f6f-8f7f-9f0f1f2f3f4f",
      },
    };
    const ended: JobEvent = {
      ...EVENT,
      type: "agent.session_ended",
      message: "Session ended.",
      data: { sessionId: "s-1", stopReason: "budget", turns: 12, inputTokens: 4, outputTokens: 5 },
    };
    const budget: JobEvent = {
      ...EVENT,
      type: "agent.budget_exceeded",
      message: "Tool call ceiling reached.",
      data: { sessionId: "s-1", budget: "tool_calls", budgetValue: 60, budgetLimit: 60 },
    };

    for (const event of [started, usage, tool, ended, budget]) {
      expect(parseSerializedJobEvent(serializeJobEvent(event))).toEqual(event);
    }
  });

  it("keeps an uncomputable cost distinct from a free turn", () => {
    // `null` is "this model has no rate table, so spend cannot be computed",
    // which the budget code has to treat differently from a turn that cost
    // nothing. Dropping the key, or coercing it to zero, loses that.
    const free = parseSerializedJobEvent(
      serializeJobEvent({ ...usage, data: { ...usage.data, costUsd: 0 } }),
    );
    const unpriced = parseSerializedJobEvent(
      serializeJobEvent({ ...usage, data: { ...usage.data, costUsd: null } }),
    );

    expect(free.data?.costUsd).toBe(0);
    expect(unpriced.data?.costUsd).toBeNull();
    expect(unpriced.data).toHaveProperty("costUsd");
  });

  it("rejects agent fields of the wrong shape", () => {
    const withData = (data: Record<string, unknown>) => ({
      ...serializeJobEvent(usage),
      data,
    });

    expect(() => parseSerializedJobEvent(withData({ turn: -1 }))).toThrow();
    expect(() => parseSerializedJobEvent(withData({ inputTokens: 12.5 }))).toThrow();
    expect(() => parseSerializedJobEvent(withData({ stopReason: "finished" }))).toThrow();
    expect(() => parseSerializedJobEvent(withData({ budget: "tokens" }))).toThrow();
    expect(() => parseSerializedJobEvent(withData({ toolNames: "bash" }))).toThrow();
  });

  it("recognises both agent failure categories", () => {
    expect(parseFailureCategory("agent_unavailable")).toBe("agent_unavailable");
    expect(parseFailureCategory("agent_failed")).toBe("agent_failed");
    // The degradation rule from M2, restated for the new entries: a category
    // written by a newer Rivet against the same database reads as `unknown`,
    // never as null, because "unrecognised failure" and "no failure" are
    // different facts.
    expect(parseFailureCategory("agent_hallucinated")).toBe("unknown");
    expect(parseFailureCategory(null)).toBeNull();
  });
});

describe("validation and artifact events", () => {
  it("round-trips every M5 field it claims to know about", () => {
    const artifact: JobEvent = {
      ...EVENT,
      type: "artifact.recorded",
      message: "Recorded a diff.",
      data: {
        phase: "testing",
        artifactId: 42,
        artifactType: "diff",
        byteSize: 300_000,
        truncated: true,
      },
    };
    const validation: JobEvent = {
      ...EVENT,
      type: "validation.recorded",
      message: "The suite passes and it did not before.",
      data: {
        phase: "testing",
        validation: "fixed",
        baseline: "failed",
        exitCode: 0,
        filesChanged: 2,
        insertions: 7,
        deletions: 3,
      },
    };
    const deferred: JobEvent = {
      ...EVENT,
      type: "plan.deferred",
      message: "Planning is deferred to Milestone 6.",
      data: { phase: "planning", durationMs: 0 },
    };

    for (const event of [artifact, validation, deferred]) {
      expect(parseSerializedJobEvent(serializeJobEvent(event))).toEqual(event);
    }
  });

  it("rejects M5 fields of the wrong shape", () => {
    const withData = (data: Record<string, unknown>) => ({
      ...serializeJobEvent(EVENT),
      data,
    });

    expect(() => parseSerializedJobEvent(withData({ artifactType: "screenshot" }))).toThrow();
    expect(() => parseSerializedJobEvent(withData({ validation: "green" }))).toThrow();
    expect(() => parseSerializedJobEvent(withData({ byteSize: -1 }))).toThrow();
    expect(() => parseSerializedJobEvent(withData({ filesChanged: 1.5 }))).toThrow();
  });

  it("recognises both validation failure categories", () => {
    expect(parseFailureCategory("no_changes_produced")).toBe("no_changes_produced");
    expect(parseFailureCategory("validation_failed")).toBe("validation_failed");
  });
});
