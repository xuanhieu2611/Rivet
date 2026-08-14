import type { JobEventData } from "@rivet/contracts";

import { AgentSessionTimedOutError } from "../agent/errors";
import type {
  AgentToolbox,
  CodingAgentEvent,
  CodingAgentSpec,
  CodingAgentUsage,
} from "../agent/coding-agent";
import type { AgentUsagePatch } from "../jobs/agent-usage";
import { BudgetExceededError, LeaseLostError } from "../jobs/failure";
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

  // Built before the session exists, because what it knows decides whether the
  // session may exist at all. A job whose cumulative model calls, tool calls or
  // spend are already at their ceiling has no room for another turn, and
  // starting one to discover that costs a provider round trip and a container's
  // worth of context to arrive at the answer already sitting in the job row.
  const state = new SessionAccounting(spec, ctx);
  await state.assertBudgetRemaining();

  const session = await agent.coding.start(spec, tools, signal);

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
 * **Every ceiling except the per-session turn limit is cumulative over the whole
 * job.** Model calls, tool calls, tokens and spend are seeded from the durable
 * job row - which already carries whatever a planner session and any
 * interrupted predecessor persisted - and written back under the lease as they
 * grow. That is what makes a crash cost a job its progress rather than reset its
 * budget: a worker dying halfway through the two hundredth model call does not
 * hand its replacement two hundred more.
 *
 * `maxTurns` is the deliberate exception. It is a property of one session -
 * "this conversation has stopped getting anywhere" - and lives on
 * `AgentOptions` rather than on the job row, so it is counted per session and
 * says so in the breach message.
 */
export class SessionAccounting {
  /** Set the moment a ceiling is reached. The caller stops the session. */
  breach: BudgetExceededError | undefined;

  /** The last non-empty assistant message, useful to implementation callers. */
  lastAssistantMessage: string | undefined;

  private sessionId: string | undefined;
  private turns = 0;
  private warnedAboutCost = false;
  /** The breach has already been persisted and announced; do not do it twice. */
  private breachSettled = false;
  private breachDetail: { value: number; limit: number } | undefined;

  private cumulativeTurns: number;
  private cumulativeModelCalls: number;
  private cumulativeToolCalls: number;
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
        totalModelCalls: ctx.job.totalModelCalls ?? 0,
        totalToolCalls: ctx.job.totalToolCalls ?? 0,
      } satisfies AgentUsageTotals);
    this.total = {
      inputTokens: persisted.totalInputTokens,
      outputTokens: persisted.totalOutputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: parseStoredCost(persisted.totalCostUsd),
    };
    this.cumulativeTurns = persisted.totalTurns ?? 0;
    this.cumulativeModelCalls = persisted.totalModelCalls ?? 0;
    this.cumulativeToolCalls = persisted.totalToolCalls ?? 0;
  }

  /**
   * Refuses a session the job cannot afford, before the provider is contacted.
   *
   * `>=` rather than `>` because this asks a different question from the checks
   * inside the run: those ask whether the call that just happened was allowed,
   * this asks whether there is room for one more. A job sitting exactly on its
   * model-call ceiling would breach on its very first turn, and failing here
   * rather than there is the difference between an explanation and a bill.
   */
  async assertBudgetRemaining(): Promise<void> {
    const limits = this.spec.limits;
    this.checkExhausted("model_calls", this.cumulativeModelCalls, limits.maxModelCalls);
    this.checkExhausted("tool_calls", this.cumulativeToolCalls, limits.maxToolCalls);
    if (limits.maxCostUsd !== null && this.total.costUsd !== null) {
      this.checkExhausted("cost", this.total.costUsd, limits.maxCostUsd);
    }

    if (!this.breach) return;
    // Nothing new to persist - these totals are what the job row already says -
    // so the breach only has to be said out loud before it is thrown.
    await this.settleBreach();
    throw this.breach;
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
        this.cumulativeModelCalls += 1;
        await this.ctx.recordAgentUsage(this.usagePatch());
        await this.write("agent.turn_started", `Turn ${this.turns}.`, { turn: event.turn });
        this.check("turns", this.turns, this.spec.limits.maxTurns);
        this.check("model_calls", this.cumulativeModelCalls, this.spec.limits.maxModelCalls);
        await this.settleBreach();
        return;
      }

      case "assistant_message": {
        if (event.text.trim().length > 0) this.lastAssistantMessage = event.text;
        await this.write("agent.message", event.text, { turn: event.turn });
        return;
      }

      case "tool_started": {
        this.cumulativeToolCalls += 1;
        await this.ctx.recordAgentUsage(this.usagePatch());
        await this.write("agent.tool_started", `${event.toolName} ${event.argsPreview}`, {
          turn: event.turn,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(event.commandExecutionId ? { commandExecutionId: event.commandExecutionId } : {}),
        });
        this.check("tool_calls", this.cumulativeToolCalls, this.spec.limits.maxToolCalls);
        await this.settleBreach();
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
        await this.settleBreach();
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
      totalModelCalls: this.cumulativeModelCalls,
      totalToolCalls: this.cumulativeToolCalls,
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
      `${SCOPE_LABELS[which]} reached its ${LIMIT_LABELS[which]} ceiling: ${formatBudget(value)} of ${formatBudget(limit)}.`,
      which,
    );
    this.breachDetail = { value, limit };
  }

  /** The pre-session form: the ceiling was reached before this session existed. */
  private checkExhausted(which: BudgetExceededError["which"], value: number, limit: number): void {
    if (this.breach || value < limit) return;
    this.breach = new BudgetExceededError(
      `This job has already spent its ${LIMIT_LABELS[which]} ceiling: ${formatBudget(value)} of ${formatBudget(limit)}. ` +
        `No ${this.spec.role} session was started.`,
      which,
    );
    this.breachDetail = { value, limit };
  }

  /**
   * Persists the totals, then says what stopped the session.
   *
   * The order is the point. A job about to move to `budget_exceeded` must leave
   * behind the counters that justify it, and persisting after the announcement
   * would leave a timeline claiming a ceiling the job row does not show. The
   * `agent.budget_exceeded` write is best effort on top of that: it is a
   * description of a decision that has already been made durable.
   */
  private async settleBreach(): Promise<void> {
    const breach = this.breach;
    const detail = this.breachDetail;
    if (!breach || !detail || this.breachSettled) return;
    this.breachSettled = true;

    await this.ctx.recordAgentUsage(this.usagePatch());
    try {
      await this.write("agent.budget_exceeded", breach.message, {
        budget: breach.which,
        budgetValue: detail.value,
        budgetLimit: detail.limit,
      });
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      this.ctx.log.warn({ err: error }, "could not record the budget breach");
    }
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

/**
 * Whose ceiling it was, said in the message rather than left to be inferred.
 *
 * Three of these are the job's and count every session and every attempt; the
 * turn ceiling is this session's alone. A breach message that did not say which
 * would send someone looking for two hundred turns in one conversation.
 */
const SCOPE_LABELS: Record<BudgetExceededError["which"], string> = {
  cost: "This job",
  model_calls: "This job",
  tool_calls: "This job",
  turns: "This session",
};

/** Whole numbers stay whole; spend keeps the cents that made it a ceiling. */
function formatBudget(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function parseStoredCost(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
