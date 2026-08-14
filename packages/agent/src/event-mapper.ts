import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { CodingAgentEvent, CodingAgentUsage } from "@rivet/core";

/**
 * Where the harness's vocabulary becomes Rivet's, and where its version risk
 * stops.
 *
 * `CodingAgentEvent` is deliberately not a passthrough of the harness's event
 * stream. It is the eight things Rivet is willing to write to `job_events`, and
 * everything else - message deltas, partial tool results, queue changes,
 * compaction, the harness's own retry bookkeeping - is dropped on this line
 * rather than three layers further in. That is what makes a new harness event
 * type a change to this file and to nothing else: not the timeline, not the
 * database, not the browser.
 *
 * The dropping is the interesting half. A `job_events` row per streamed token
 * would cost Milestone 3's guarantee of one bounded query per second per viewer
 * and produce a timeline nobody can read. A ten-minute session should leave
 * tens of rows behind. If it ever leaves thousands, look here first.
 */

/** What the mapper knows about the session so far, read when it ends. */
export interface SessionProgress {
  /** How many turns have started. */
  turns: number;
  /** Every turn's usage, added up. */
  usage: CodingAgentUsage;
  /**
   * The harness's own report that the run failed, from the final assistant
   * message rather than from a thrown error.
   *
   * This is how the harness reports a provider failure: `prompt()` resolves
   * normally and the last assistant message carries `stopReason: "error"` with
   * an `errorMessage`. A caller that only watches for exceptions sees a session
   * that finished quietly having done nothing, which is the worst of both
   * worlds - no patch and no explanation.
   */
  failure: string | undefined;
  /** The harness reported the run was aborted rather than finished. */
  aborted: boolean;
}

export function emptyUsage(): CodingAgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

export class PiEventMapper {
  private turn = 0;
  private turnStarted = false;
  private readonly toolStartedAt = new Map<string, number>();
  private readonly commandIds = new Map<string, string>();

  private readonly state: SessionProgress = {
    turns: 0,
    usage: emptyUsage(),
    failure: undefined,
    aborted: false,
  };

  constructor(private readonly previewMaxBytes: number) {}

  get progress(): SessionProgress {
    return this.state;
  }

  /**
   * Notes that a tool call ran a command, so its events can point at the
   * transcript.
   *
   * Called from the tool layer rather than derived from a harness event,
   * because the harness has no idea Rivet recorded anything.
   */
  recordCommand(toolCallId: string, commandExecutionId: string): void {
    this.commandIds.set(toolCallId, commandExecutionId);
  }

  /** Zero, one or two Rivet events for one harness event. */
  map(event: AgentSessionEvent): CodingAgentEvent[] {
    switch (event.type) {
      case "turn_start": {
        // Counted here rather than read off the harness, which exposes no turn
        // index on this event. The first turn is 0.
        if (this.turnStarted) this.turn += 1;
        this.turnStarted = true;
        this.state.turns = this.turn + 1;
        return [{ type: "turn_started", turn: this.turn }];
      }

      case "turn_end":
        return [{ type: "turn_completed", turn: this.turn }];

      case "message_end":
        return this.mapAssistantMessage(event.message);

      case "tool_execution_start": {
        this.toolStartedAt.set(event.toolCallId, Date.now());
        return [
          {
            type: "tool_started",
            turn: this.turn,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            argsPreview: this.preview(renderArguments(event.args)),
            ...this.commandFor(event.toolCallId),
          },
        ];
      }

      case "tool_execution_end": {
        const startedAt = this.toolStartedAt.get(event.toolCallId);
        this.toolStartedAt.delete(event.toolCallId);
        return [
          {
            type: "tool_completed",
            turn: this.turn,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            durationMs: startedAt === undefined ? 0 : Date.now() - startedAt,
            resultPreview: this.preview(renderResult(event.result)),
            ...this.commandFor(event.toolCallId),
          },
        ];
      }

      default:
        // Everything else on purpose: message deltas, partial tool results,
        // compaction, queue changes, the harness's own retry scheduling. None
        // of them are facts about the job that survive being read a week later.
        return [];
    }
  }

  /**
   * One assistant message becomes at most two rows: what it said, and what it
   * cost.
   *
   * Read at `message_end` rather than at `message_update`, because usage lives
   * on the assistant message and is only complete once the message is. Taking
   * it per delta would also mean a usage row per token, which is the thing this
   * whole design is arranged to avoid.
   */
  private mapAssistantMessage(message: unknown): CodingAgentEvent[] {
    if (!isAssistantMessage(message)) return [];

    if (message.stopReason === "error") {
      this.state.failure = message.errorMessage ?? "The model provider reported an error.";
    }
    if (message.stopReason === "aborted") {
      this.state.aborted = true;
    }

    const events: CodingAgentEvent[] = [];

    const text = message.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    if (text) {
      events.push({ type: "assistant_message", turn: this.turn, text: this.preview(text) });
    }

    const usage = readUsage(message.usage);
    if (usage) {
      accumulate(this.state.usage, usage);
      events.push({ type: "usage", turn: this.turn, usage });
    }

    return events;
  }

  /** `exactOptionalPropertyTypes` wants an absent key, not an explicit undefined. */
  private commandFor(toolCallId: string): { commandExecutionId?: string } {
    const commandExecutionId = this.commandIds.get(toolCallId);
    return commandExecutionId ? { commandExecutionId } : {};
  }

  /**
   * Cuts on bytes rather than characters, because the bound exists to protect a
   * database column and a page render, and both count bytes.
   */
  private preview(text: string): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength <= this.previewMaxBytes) return text;
    return `${bytes.subarray(0, this.previewMaxBytes).toString("utf8")}…`;
  }
}

/** Adds one turn's usage into a running total, leaving an unpriced model null. */
export function accumulate(total: CodingAgentUsage, turn: CodingAgentUsage): void {
  total.inputTokens += turn.inputTokens;
  total.outputTokens += turn.outputTokens;
  total.cacheReadTokens += turn.cacheReadTokens;
  total.cacheWriteTokens += turn.cacheWriteTokens;
  // Null is contagious on purpose. One unpriced turn makes the session total
  // unknowable, and reporting the sum of the turns that *could* be priced as if
  // it were the whole bill is worse than admitting the number is not available.
  total.costUsd =
    total.costUsd === null || turn.costUsd === null ? null : total.costUsd + turn.costUsd;
}

function isAssistantMessage(value: unknown): value is {
  role: "assistant";
  content: ({ type: string } & Record<string, unknown>)[];
  usage?: unknown;
  stopReason?: string;
  errorMessage?: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { role?: unknown; content?: unknown };
  return message.role === "assistant" && Array.isArray(message.content);
}

/**
 * Reads the provider's usage report, or admits there was not one.
 *
 * Defensive about the numbers rather than trusting the type, because this is
 * the one field in the whole integration that a *third party* populates. The
 * transport asks for usage on a streamed completion, but "the field exists and
 * was requested" is not "the provider filled it in", and a `NaN` reaching the
 * budget arithmetic would disable a ceiling without saying so.
 */
function readUsage(value: unknown): CodingAgentUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const usage = value as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: { total?: unknown };
  };

  const inputTokens = count(usage.input);
  const outputTokens = count(usage.output);
  const cacheReadTokens = count(usage.cacheRead);
  const cacheWriteTokens = count(usage.cacheWrite);
  const total = usage.cost?.total;
  const costUsd = typeof total === "number" && Number.isFinite(total) ? total : null;

  if (inputTokens === 0 && outputTokens === 0 && costUsd === null) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** A tool call's arguments, as one line for the timeline. Never the arguments. */
function renderArguments(args: unknown): string {
  if (typeof args === "string") return args;
  if (typeof args === "number" || typeof args === "boolean") return String(args);
  if (typeof args !== "object" || args === null) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return "(unserialisable arguments)";
  }
}

/** The text a tool returned, flattened out of the harness's content array. */
function renderResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return "";

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}
