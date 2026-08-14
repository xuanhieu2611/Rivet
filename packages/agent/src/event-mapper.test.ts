import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { accumulate, emptyUsage, PiEventMapper } from "./event-mapper";

/**
 * Fixtures shaped like the harness's events, mapped into Rivet's.
 *
 * Hand-built rather than recorded, and the trade is deliberate: a recorded
 * fixture proves the mapping against one version of one provider on one day,
 * while these state what Rivet actually depends on - a `turn_start` with no
 * index, usage that lives on the assistant message rather than on the update,
 * a tool result that is a content array. If the harness changes any of those,
 * the fix belongs in `event-mapper.ts` and these are what will say so.
 */

function event(value: unknown): AgentSessionEvent {
  return value as AgentSessionEvent;
}

function assistant(overrides: Record<string, unknown> = {}): AgentSessionEvent {
  return event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Looking at the failing test." }],
      usage: {
        input: 1_000,
        output: 200,
        cacheRead: 50,
        cacheWrite: 10,
        totalTokens: 1_200,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
      },
      stopReason: "stop",
      ...overrides,
    },
  });
}

describe("PiEventMapper", () => {
  it("numbers turns itself, because the harness does not", () => {
    const mapper = new PiEventMapper(1_000);

    expect(mapper.map(event({ type: "turn_start" }))).toEqual([{ type: "turn_started", turn: 0 }]);
    expect(mapper.map(event({ type: "turn_end" }))).toEqual([{ type: "turn_completed", turn: 0 }]);
    expect(mapper.map(event({ type: "turn_start" }))).toEqual([{ type: "turn_started", turn: 1 }]);
    expect(mapper.progress.turns).toBe(2);
  });

  it("splits one assistant message into what it said and what it cost", () => {
    const mapper = new PiEventMapper(1_000);
    mapper.map(event({ type: "turn_start" }));

    expect(mapper.map(assistant())).toEqual([
      { type: "assistant_message", turn: 0, text: "Looking at the failing test." },
      {
        type: "usage",
        turn: 0,
        usage: {
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 50,
          cacheWriteTokens: 10,
          costUsd: 0.3,
        },
      },
    ]);
    expect(mapper.progress.usage.inputTokens).toBe(1_000);
    expect(mapper.progress.usage.costUsd).toBe(0.3);
  });

  it("emits no usage row for a turn the provider did not price or count", () => {
    const mapper = new PiEventMapper(1_000);
    const mapped = mapper.map(
      assistant({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: {} } }),
    );

    expect(mapped.map((item) => item.type)).toEqual(["assistant_message"]);
  });

  it("reports a provider failure that the harness returned rather than threw", () => {
    const mapper = new PiEventMapper(1_000);
    mapper.map(assistant({ stopReason: "error", errorMessage: "429 rate limited", content: [] }));

    expect(mapper.progress.failure).toBe("429 rate limited");
  });

  it("notices an aborted run", () => {
    const mapper = new PiEventMapper(1_000);
    mapper.map(assistant({ stopReason: "aborted", content: [] }));

    expect(mapper.progress.aborted).toBe(true);
  });

  it("pairs a tool start with its completion and times it", () => {
    const mapper = new PiEventMapper(1_000);
    const started = mapper.map(
      event({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "src/sum.ts" },
      }),
    );
    expect(started).toEqual([
      {
        type: "tool_started",
        turn: 0,
        toolCallId: "call-1",
        toolName: "read",
        argsPreview: '{"path":"src/sum.ts"}',
      },
    ]);

    const finished = mapper.map(
      event({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "export function sum() {}" }] },
        isError: false,
      }),
    );
    expect(finished[0]).toMatchObject({
      type: "tool_completed",
      toolCallId: "call-1",
      isError: false,
      resultPreview: "export function sum() {}",
    });
  });

  it("carries a tool error through as a result rather than a failure", () => {
    const mapper = new PiEventMapper(1_000);
    mapper.map(
      event({ type: "tool_execution_start", toolCallId: "c", toolName: "edit", args: {} }),
    );
    const [completed] = mapper.map(
      event({
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "edit",
        result: { content: [{ type: "text", text: "oldText not found" }] },
        isError: true,
      }),
    );

    expect(completed).toMatchObject({ isError: true, resultPreview: "oldText not found" });
    expect(mapper.progress.failure).toBeUndefined();
  });

  it("points a shell tool call at the command transcript it produced", () => {
    const mapper = new PiEventMapper(1_000);
    mapper.recordCommand("call-9", "exec-abc");

    const [started] = mapper.map(
      event({ type: "tool_execution_start", toolCallId: "call-9", toolName: "bash", args: {} }),
    );

    expect(started).toMatchObject({ commandExecutionId: "exec-abc" });
  });

  it("truncates a preview on bytes", () => {
    const mapper = new PiEventMapper(8);
    const [message] = mapper.map(
      assistant({ content: [{ type: "text", text: "0123456789" }], usage: undefined }),
    );

    expect(message).toEqual({ type: "assistant_message", turn: 0, text: "01234567…" });
  });

  it("drops everything Rivet is not willing to persist", () => {
    const mapper = new PiEventMapper(1_000);

    for (const type of [
      "agent_start",
      "message_start",
      "message_update",
      "tool_execution_update",
      "compaction_start",
      "queue_update",
      "auto_retry_start",
    ]) {
      expect(mapper.map(event({ type }))).toEqual([]);
    }
  });
});

describe("accumulate", () => {
  it("adds a turn into a running total", () => {
    const total = emptyUsage();
    accumulate(total, {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      costUsd: 0.5,
    });
    accumulate(total, {
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.25,
    });

    expect(total).toEqual({
      inputTokens: 15,
      outputTokens: 4,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      costUsd: 0.75,
    });
  });

  it("makes one unpriced turn poison the total, rather than understating it", () => {
    const total = emptyUsage();
    accumulate(total, {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.5,
    });
    accumulate(total, {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    });

    expect(total.costUsd).toBeNull();
    expect(total.inputTokens).toBe(20);
  });
});
