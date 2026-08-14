import { describe, expect, it } from "vitest";

import type {
  AgentToolbox,
  CodingAgent,
  CodingAgentEvent,
  CodingAgentSession,
  CodingAgentSpec,
} from "./coding-agent";

/**
 * The port has no implementation to test, so what is worth asserting is that it
 * is implementable and that its union is closed.
 *
 * The exhaustive switch below is the load-bearing half: adding a case to
 * `CodingAgentEvent` without handling it fails `pnpm typecheck` here, which is
 * the same trick `JOB_EVENT_TONE` plays on `JobEventType`. A new event that the
 * phase silently drops would be a fact about a job that never reaches the
 * timeline, and that is exactly the sort of thing nobody notices for a month.
 */

const SPEC: CodingAgentSpec = {
  workdir: "/home/node/workspace/repo",
  task: { title: "Fix the off-by-one in sum()", description: "The last element is dropped." },
  context: "package manager: pnpm\nbaseline: failed",
  sessionTimeoutMs: 900_000,
  commandTimeoutMs: 120_000,
  previewMaxBytes: 4_096,
  limits: { maxTurns: 40, maxToolCalls: 60, maxModelCalls: 60, maxCostUsd: 1 },
};

const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
};

/** The shape every scripted fake in `packages/agent` will take, in miniature. */
class ScriptedAgent implements CodingAgent {
  stopped = 0;

  constructor(private readonly script: CodingAgentEvent[]) {}

  start(spec: CodingAgentSpec, tools: AgentToolbox, signal: AbortSignal) {
    void spec;
    void tools;
    const script = this.script;
    const session: CodingAgentSession = {
      id: "session-1",
      run: async function* () {
        for (const event of script) {
          signal.throwIfAborted();
          yield await Promise.resolve(event);
        }
      },
      stop: () => {
        this.stopped += 1;
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  }
}

/** What a consumer of the port does with an event, minus the database. */
function describeEvent(event: CodingAgentEvent): string {
  switch (event.type) {
    case "session_started":
      return `session ${event.sessionId} on ${event.provider}/${event.model}`;
    case "turn_started":
      return `turn ${event.turn} started`;
    case "assistant_message":
      return `message: ${event.text}`;
    case "tool_started":
      return `${event.toolName} started`;
    case "tool_completed":
      return `${event.toolName} ${event.isError ? "failed" : "completed"}`;
    case "usage":
      return `turn ${event.turn} used ${event.usage.inputTokens + event.usage.outputTokens} tokens`;
    case "turn_completed":
      return `turn ${event.turn} completed`;
    case "session_ended":
      return `session ended: ${event.reason}`;
    default: {
      // Unreachable while the union is fully handled above, and a compile
      // error the moment it is not.
      const unhandled: never = event;
      return unhandled;
    }
  }
}

describe("the coding agent port", () => {
  it("is implementable as an async iterable a consumer can drive", async () => {
    const agent = new ScriptedAgent([
      {
        type: "session_started",
        sessionId: "session-1",
        model: "deepseek/deepseek-v4-flash",
        provider: "openrouter",
        toolNames: ["bash", "edit", "read", "write"],
      },
      { type: "turn_started", turn: 0 },
      { type: "assistant_message", turn: 0, text: "Reading the file." },
      {
        type: "tool_started",
        turn: 0,
        toolCallId: "call-1",
        toolName: "bash",
        argsPreview: "pnpm test",
        commandExecutionId: "exec-1",
      },
      {
        type: "tool_completed",
        turn: 0,
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        durationMs: 4_100,
        resultPreview: "1 passed",
        commandExecutionId: "exec-1",
      },
      { type: "usage", turn: 0, usage: { ...NO_USAGE, inputTokens: 900, outputTokens: 120 } },
      { type: "turn_completed", turn: 0 },
      { type: "session_ended", reason: "completed", turns: 1, usage: NO_USAGE },
    ]);

    const toolbox = {} as AgentToolbox;
    const session = await agent.start(SPEC, toolbox, new AbortController().signal);

    const seen: string[] = [];
    for await (const event of session.run(new AbortController().signal)) {
      seen.push(describeEvent(event));
    }
    await session.stop();

    expect(seen).toEqual([
      "session session-1 on openrouter/deepseek/deepseek-v4-flash",
      "turn 0 started",
      "message: Reading the file.",
      "bash started",
      "bash completed",
      "turn 0 used 1020 tokens",
      "turn 0 completed",
      "session ended: completed",
    ]);
    expect(agent.stopped).toBe(1);
  });

  it("stops iterating when the consumer's signal aborts", async () => {
    // The property the cancellation path depends on: a consumer that stops
    // pulling, or a signal that fires mid-stream, ends the session rather than
    // leaving it producing events into nothing.
    const agent = new ScriptedAgent([
      { type: "turn_started", turn: 0 },
      { type: "turn_started", turn: 1 },
      { type: "turn_started", turn: 2 },
    ]);
    const controller = new AbortController();
    const session = await agent.start(SPEC, {} as AgentToolbox, controller.signal);

    const seen: CodingAgentEvent[] = [];
    await expect(async () => {
      for await (const event of session.run(controller.signal)) {
        seen.push(event);
        controller.abort();
      }
    }).rejects.toThrow();

    expect(seen).toHaveLength(1);
  });
});
