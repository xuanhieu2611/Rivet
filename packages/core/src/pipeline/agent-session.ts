import type { JobEventData } from "@rivet/contracts";

import { AgentSessionTimedOutError } from "../agent/errors";
import type {
  AgentToolbox,
  CodingAgentEvent,
  CodingAgentSpec,
  CodingAgentUsage,
} from "../agent/coding-agent";
import type { AgentUsagePatch } from "../jobs/agent-usage";
import { BudgetExceededError } from "../jobs/failure";
import type { AgentUsageTotals, PhaseContext } from "./phase-context";
import type { AgentOptions } from "./phases";

/**
 * Runs one role-specific coding session with the same lifecycle and accounting
 * rules for planners and implementers.
 */
export async function runAgentSession(
  agent: AgentOptions,
  spec: CodingAgentSpec,
  tools: AgentToolbox,
  ctx: PhaseContext,
): Promise<SessionAccounting> {
  const deadline = AbortSignal.timeout(agent.sessionTimeoutMs);
  const signal = AbortSignal.any([ctx.signal, deadline]);

  const session = await agent.coding.start(spec, tools, signal);
  const state = new SessionAccounting(spec, ctx);

  try {
    for await (const event of session.run(signal)) {
      await state.record(event);
      if (state.breach) break;
    }
  } catch (error) {
    // A composed signal aborts with whichever reason fired. The job's own
    // reason wins because it carries cancellation, timeout, or lease loss.
    ctx.signal.throwIfAborted();
    throw deadline.aborted ? sessionExpired(agent.sessionTimeoutMs) : error;
  } finally {
    await session.stop();
  }

  if (state.breach) throw state.breach;

  ctx.signal.throwIfAborted();
  if (deadline.aborted) throw sessionExpired(agent.sessionTimeoutMs);
  return state;
}

function sessionExpired(sessionTimeoutMs: number): AgentSessionTimedOutError {
  return new AgentSessionTimedOutError(
    `The coding session did not finish inside its ${Math.round(sessionTimeoutMs / 1_000)}s budget. ` +
      "The job's own deadline was not reached; the session's was.",
  );
}

/**
 * The running totals, ceilings, and timeline writes shared by every role.
 *
 * Usage is persisted after each reported turn through PhaseContext, so planning
 * and implementation spend from the same durable job totals.
 */
export class SessionAccounting {
  /** Set the moment a ceiling is reached. The caller stops the session. */
  breach: BudgetExceededError | undefined;

  /** The last non-empty assistant message, useful to implementation callers. */
  lastAssistantMessage: string | undefined;

  private sessionId: string | undefined;
  private turns = 0;
  private toolCalls = 0;
  private warnedAboutCost = false;

  private cumulativeTurns: number;
  private readonly total: CodingAgentUsage;
  private readonly sessionTotal: CodingAgentUsage = emptyUsage();

  constructor(
    private readonly spec: CodingAgentSpec,
    private readonly ctx: PhaseContext,
  ) {
    const persisted =
      ctx.readAgentUsage?.() ??
      ({
        totalInputTokens: ctx.job.totalInputTokens ?? 0,
        totalOutputTokens: ctx.job.totalOutputTokens ?? 0,
        totalCostUsd: ctx.job.totalCostUsd,
        totalTurns: ctx.job.totalTurns ?? 0,
      } satisfies AgentUsageTotals);
    this.total = {
      inputTokens: persisted.totalInputTokens,
      outputTokens: persisted.totalOutputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: parseStoredCost(persisted.totalCostUsd),
    };
    this.cumulativeTurns = persisted.totalTurns ?? 0;
  }

  async record(event: CodingAgentEvent): Promise<void> {
    switch (event.type) {
      case "session_started": {
        this.sessionId = event.sessionId;
        await this.write("agent.session_started", `Started ${event.model} on ${event.provider}.`, {
          model: event.model,
          provider: event.provider,
          toolNames: event.toolNames,
        });
        return;
      }

      case "turn_started": {
        this.turns += 1;
        await this.write("agent.turn_started", `Turn ${this.turns}.`, { turn: event.turn });
        this.check("turns", this.turns, this.spec.limits.maxTurns);
        this.check("model_calls", this.turns, this.spec.limits.maxModelCalls);
        return;
      }

      case "assistant_message": {
        if (event.text.trim().length > 0) this.lastAssistantMessage = event.text;
        await this.write("agent.message", event.text, { turn: event.turn });
        return;
      }

      case "tool_started": {
        this.toolCalls += 1;
        await this.write("agent.tool_started", `${event.toolName} ${event.argsPreview}`, {
          turn: event.turn,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(event.commandExecutionId ? { commandExecutionId: event.commandExecutionId } : {}),
        });
        this.check("tool_calls", this.toolCalls, this.spec.limits.maxToolCalls);
        return;
      }

      case "tool_completed": {
        await this.write(
          "agent.tool_completed",
          event.isError
            ? `${event.toolName} failed: ${event.resultPreview}`
            : `${event.toolName} finished.`,
          {
            turn: event.turn,
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            toolError: event.isError,
            durationMs: event.durationMs,
            ...(event.commandExecutionId ? { commandExecutionId: event.commandExecutionId } : {}),
          },
        );
        return;
      }

      case "usage": {
        this.add(event.usage);
        await this.ctx.recordAgentUsage(this.usagePatch());
        await this.write("agent.usage", this.describeUsage(event.usage), {
          turn: event.turn,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          costUsd: this.sessionTotal.costUsd,
        });
        this.checkCost();
        return;
      }

      case "turn_completed": {
        this.cumulativeTurns += 1;
        await this.ctx.recordAgentUsage(this.usagePatch());
        await this.write("agent.turn_completed", `Turn ${event.turn} completed.`, {
          turn: event.turn,
          cumulativeTurn: this.cumulativeTurns,
        });

        // Planner turns contribute to the job's cumulative counter, but only
        // implementation turns produce workspace checkpoints. A planner has
        // no writable workspace and its phase boundary is the durable handoff.
        if (this.spec.role === "implementer") {
          await this.ctx.checkpoint({
            kind: "agent_turn",
            agentTurn: this.cumulativeTurns,
            repositoryDir: this.spec.workdir,
            state: { version: 1 },
          });
        }
        return;
      }

      case "session_ended": {
        await this.write("agent.session_ended", `Session ended: ${event.reason}.`, {
          stopReason: event.reason,
          turns: event.turns,
          inputTokens: this.sessionTotal.inputTokens,
          outputTokens: this.sessionTotal.outputTokens,
          costUsd: this.sessionTotal.costUsd,
          ...(event.error ? { error: event.error } : {}),
        });
        return;
      }
    }
  }

  private add(usage: CodingAgentUsage): void {
    addUsage(this.total, usage);
    addUsage(this.sessionTotal, usage);
  }

  private usagePatch(): AgentUsagePatch {
    return {
      totalInputTokens: this.total.inputTokens,
      totalOutputTokens: this.total.outputTokens,
      ...(this.total.costUsd === null ? {} : { totalCostUsd: this.total.costUsd.toFixed(4) }),
      totalTurns: this.cumulativeTurns,
    };
  }

  private describeUsage(usage: CodingAgentUsage): string {
    const tokens = `${usage.inputTokens} in / ${usage.outputTokens} out`;
    if (this.sessionTotal.costUsd !== null) {
      return `${tokens}, $${this.sessionTotal.costUsd.toFixed(4)} this session.`;
    }
    return `${tokens}. This model has no rate table, so spend cannot be computed.`;
  }

  private check(which: BudgetExceededError["which"], value: number, limit: number): void {
    if (this.breach || value <= limit) return;
    this.breach = new BudgetExceededError(
      `The ${this.spec.role} session reached its ${LIMIT_LABELS[which]} ceiling: ${value} of ${limit}.`,
      which,
    );
    void this.writeBreach(value, limit);
  }

  private checkCost(): void {
    const limit = this.spec.limits.maxCostUsd;
    if (limit === null) return;

    if (this.total.costUsd === null) {
      if (this.warnedAboutCost) return;
      this.warnedAboutCost = true;
      this.ctx.log.warn(
        { sessionId: this.sessionId, maxCostUsd: limit, agentRole: this.spec.role },
        "spend cannot be computed for this model, so the cost ceiling is not being enforced",
      );
      return;
    }

    this.check("cost", this.total.costUsd, limit);
  }

  private async writeBreach(value: number, limit: number): Promise<void> {
    const breach = this.breach;
    if (!breach) return;
    try {
      await this.write("agent.budget_exceeded", breach.message, {
        budget: breach.which,
        budgetValue: value,
        budgetLimit: limit,
      });
    } catch (error) {
      this.ctx.log.warn({ err: error }, "could not record the budget breach");
    }
  }

  private write(
    type: Parameters<PhaseContext["event"]>[0]["type"],
    message: string,
    data: JobEventData,
  ): Promise<void> {
    return this.ctx.event({
      type,
      message,
      data: {
        ...data,
        agentRole: this.spec.role,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      },
    });
  }
}

function emptyUsage(): CodingAgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

function addUsage(total: CodingAgentUsage, usage: CodingAgentUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  total.costUsd =
    total.costUsd === null || usage.costUsd === null ? null : total.costUsd + usage.costUsd;
}

const LIMIT_LABELS: Record<BudgetExceededError["which"], string> = {
  cost: "spend",
  model_calls: "model call",
  tool_calls: "tool call",
  turns: "turn",
};

function parseStoredCost(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
