import type { JobDetail } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import type { CodingAgentSpec } from "../agent/coding-agent";
import { SessionAccounting } from "../pipeline/agent-session";
import type { PhaseContext } from "../pipeline/phase-context";

import {
  METRIC_JOB_COST_USD,
  METRIC_JOB_DURATION,
  METRIC_JOB_INPUT_TOKENS,
  METRIC_JOB_OUTPUT_TOKENS,
  METRIC_JOBS_COMPLETED,
  METRIC_MODEL_CALLS,
  METRIC_MODEL_LATENCY,
  METRIC_JOBS_FINISHED,
  recordCount,
  recordDuration,
  recordLevel,
  recordTerminalJobMetrics,
} from "./metrics";
import { RecordingTelemetry } from "./recording-telemetry";

describe("telemetry metrics", () => {
  it("uses committed terminal timestamps for job duration", () => {
    const telemetry = new RecordingTelemetry();
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const completedAt = new Date("2026-01-01T00:00:01.250Z");

    recordTerminalJobMetrics(telemetry, {
      status: "completed",
      startedAt,
      completedAt,
    });

    expect(telemetry.measurementsNamed(METRIC_JOB_DURATION)).toEqual([
      expect.objectContaining({ kind: "histogram", value: 1_250 }),
    ]);
    expect(telemetry.total(METRIC_JOBS_FINISHED)).toBe(1);
    expect(telemetry.total(METRIC_JOBS_COMPLETED)).toBe(1);
  });

  it("does not invent a duration when a terminal row has no start", () => {
    const telemetry = new RecordingTelemetry();

    recordTerminalJobMetrics(telemetry, {
      status: "cancelled",
      startedAt: null,
      completedAt: new Date(),
      failureCategory: "cancelled",
    });

    expect(telemetry.measurementsNamed(METRIC_JOB_DURATION)).toEqual([]);
    expect(telemetry.total(METRIC_JOBS_FINISHED)).toBe(1);
  });

  it("normalizes duration, count and level observations through the port", () => {
    const telemetry = new RecordingTelemetry();

    recordDuration(telemetry, "rivet.test.duration", -10);
    recordCount(telemetry, "rivet.test.count", 2, { outcome: "ok" });
    recordLevel(telemetry, "rivet.test.level", 3, { worker: "worker-1" });

    expect(telemetry.measurements).toEqual([
      expect.objectContaining({ kind: "histogram", name: "rivet.test.duration", value: 0 }),
      expect.objectContaining({
        kind: "counter",
        name: "rivet.test.count",
        value: 2,
        attributes: { outcome: "ok" },
      }),
      expect.objectContaining({
        kind: "gauge",
        name: "rivet.test.level",
        value: 3,
        attributes: { worker: "worker-1" },
      }),
    ]);
  });

  it("records model usage using the same rounded cost as the job row", async () => {
    const telemetry = new RecordingTelemetry();
    let now = 100;
    const context = {
      job: {
        id: "job-1",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: "0",
        totalTurns: 0,
        totalModelCalls: 0,
        totalToolCalls: 0,
      } as unknown as JobDetail,
      phase: { status: "planning", label: "Plan", durationMs: 0, recovery: "replay" },
      signal: new AbortController().signal,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      telemetry,
      now: () => now,
      recordAgentUsage: () => Promise.resolve(),
      event: () => Promise.resolve(),
    } as unknown as PhaseContext;
    const spec = {
      role: "planner",
      workdir: "/workspace/repo",
      task: { title: "Task", description: "Description" },
      context: "",
      sessionTimeoutMs: 60_000,
      commandTimeoutMs: 1_000,
      previewMaxBytes: 1_024,
      limits: { maxTurns: 4, maxToolCalls: 4, maxModelCalls: 4, maxCostUsd: null },
    } satisfies CodingAgentSpec;
    const state = new SessionAccounting(spec, context);

    await state.record({
      type: "session_started",
      sessionId: "session-1",
      model: "model-1",
      provider: "provider-1",
      toolNames: [],
    });
    await state.record({ type: "turn_started", turn: 1 });
    await state.record({
      type: "usage",
      turn: 1,
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.123456,
      },
    });
    now = 275;
    await state.record({ type: "turn_completed", turn: 1 });

    expect(telemetry.total(METRIC_JOB_INPUT_TOKENS)).toBe(11);
    expect(telemetry.total(METRIC_JOB_OUTPUT_TOKENS)).toBe(7);
    expect(telemetry.total(METRIC_JOB_COST_USD)).toBe(0.1235);
    expect(telemetry.total(METRIC_MODEL_CALLS)).toBe(1);
    expect(telemetry.total(METRIC_MODEL_LATENCY)).toBe(175);
  });
});
