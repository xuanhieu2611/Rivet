import type { JobEventData } from "@rivet/contracts";

import { AgentSessionTimedOutError } from "../agent/errors";
import type {
  AgentToolbox,
  CodingAgentEvent,
  CodingAgentSpec,
  CodingAgentUsage,
} from "../agent/coding-agent";
import { BudgetExceededError } from "../jobs/failure";
import { splitLines } from "./command-output";
import type { PhaseContext } from "./phase-context";
import type { AgentOptions, PipelineOptions } from "./phases";
import { detectPackageManager, type ProjectPlan, REPO_DIRNAME } from "./project";

/**
 * Phase four, for real: a model, four tools, and a container to use them in.
 *
 * The shape worth holding on to is that **this phase is the only thing that
 * writes anything**. The harness runs on the worker host and produces events;
 * the tools it calls end at `AgentToolbox`, which is built here out of the
 * phase's own `ctx.exec` and the sandbox's file methods. So an agent's shell
 * command produces exactly the `command.started` / `command.completed` pair and
 * exactly the `job_commands` transcript row that `provisioning` produces, with
 * no second code path and no new event types - a shell command the model ran
 * and a shell command Rivet ran are the same kind of fact about a job, and they
 * should be indistinguishable on the timeline.
 *
 * Budgets are enforced here rather than inside the adapter, so that every
 * harness gets the same behaviour rather than whatever its author implemented.
 * Deadlines are composed here for the same reason: the session's own deadline
 * is Rivet's, not the harness's, and a harness that decided to ignore it would
 * still be stopped.
 *
 * What this phase deliberately does not do is judge the result. Completion
 * detection, diff persistence and implementation summaries are Milestone 5,
 * where a failure means the prompt was wrong rather than the wiring.
 */

/**
 * How much of the file listing the model is given up front.
 *
 * Enough to orient in a normal repository, small enough that a monorepo with
 * fifty thousand files does not spend the entire context window before the
 * first turn. The model has `bash` and can look at the rest.
 */
const CONTEXT_FILE_LIMIT = 300;

export function implementingPhase(
  agent: AgentOptions,
  options: PipelineOptions,
): (ctx: PhaseContext) => Promise<void> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;

  return async function implement(ctx: PhaseContext): Promise<void> {
    const sandbox = ctx.sandboxes.require();

    const spec: CodingAgentSpec = {
      workdir: repoDir,
      task: { title: ctx.job.title, description: ctx.job.description },
      context: await buildContext(ctx, options, repoDir),
      sessionTimeoutMs: agent.sessionTimeoutMs,
      commandTimeoutMs: options.commandTimeoutMs,
      previewMaxBytes: agent.previewMaxBytes,
      limits: {
        maxTurns: agent.maxTurns,
        maxToolCalls: ctx.job.maxToolCalls,
        maxModelCalls: ctx.job.maxModelCalls,
        // `numeric` comes back from Postgres as a string, and `Number("")` is
        // zero rather than NaN - which would be a budget of nothing rather than
        // an absent one. Parsed explicitly so an unusable value becomes null,
        // which the enforcement below reports rather than silently applies.
        maxCostUsd: parseCostCeiling(ctx.job.maxCostUsd),
      },
    };

    /**
     * Every capability the model has, and there are exactly three.
     *
     * `exec` is deliberately the phase's own, which is the whole reason the
     * agent's commands are recorded like everyone else's. The two file methods
     * come straight off the sandbox, bounded by configuration rather than by
     * anything in this package.
     */
    const toolbox: AgentToolbox = {
      readFile: (path, signal) => sandbox.getFile(path, { maxBytes: agent.fileMaxBytes }, signal),
      writeFile: (path, content, signal) => sandbox.putFile(path, content, signal),
      exec: (input) => ctx.exec({ argv: input.argv, cwd: input.cwd, timeoutMs: input.timeoutMs }),
    };

    // Three deadlines, three owners. The job's own budget already lives on
    // `ctx.signal`, put there by the processor; this adds the session's, which
    // is a different question - "has the model stopped making progress" rather
    // than "has this job taken too long". Composing them means the harness is
    // told about both through the one signal it was given.
    const deadline = AbortSignal.timeout(agent.sessionTimeoutMs);
    const signal = AbortSignal.any([ctx.signal, deadline]);

    const session = await agent.coding.start(spec, toolbox, signal);
    const state = new SessionAccounting(spec, ctx);

    try {
      for await (const event of session.run(signal)) {
        await state.record(event);
        if (state.breach) break;
      }
    } catch (error) {
      // A composed signal aborts with whichever reason fired, and the raw
      // `TimeoutError` that `AbortSignal.timeout` produces is not a sentence
      // anyone wants on a job. Translate it, and let the job's own reason win
      // when both are in play - the processor put a real cause on `ctx.signal`,
      // and "the session ran out of time" would be a worse answer than "the
      // user pressed cancel".
      ctx.signal.throwIfAborted();
      throw deadline.aborted ? sessionExpired(agent.sessionTimeoutMs) : error;
    } finally {
      // Always, on every one of those paths. A session left running after its
      // phase has moved on is a model spending tokens on a job that is no
      // longer listening.
      await session.stop();
    }

    if (state.breach) throw state.breach;

    // The same two questions again, for an adapter that ends its stream
    // cleanly on an abort rather than throwing out of it. Both shapes are
    // legal - the port only promises that `run` throws when the session cannot
    // continue - so both have to be handled.
    ctx.signal.throwIfAborted();
    if (deadline.aborted) throw sessionExpired(agent.sessionTimeoutMs);
  };
}

function sessionExpired(sessionTimeoutMs: number): AgentSessionTimedOutError {
  return new AgentSessionTimedOutError(
    `The coding session did not finish inside its ${Math.round(sessionTimeoutMs / 1_000)}s budget. ` +
      `The job's own deadline was not reached; the session's was.`,
  );
}

/**
 * The running totals, the ceilings, and the timeline writes.
 *
 * One class rather than five closures because every one of these numbers is
 * read by the check that follows it, and a budget that is accumulated in one
 * place and enforced in another is a budget that eventually disagrees with
 * itself.
 */
class SessionAccounting {
  /** Set the moment a ceiling is reached. The phase stops and throws it. */
  breach: BudgetExceededError | undefined;

  private sessionId: string | undefined;
  private turns = 0;
  private toolCalls = 0;
  private warnedAboutCost = false;

  private readonly total: CodingAgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };

  constructor(
    private readonly spec: CodingAgentSpec,
    private readonly ctx: PhaseContext,
  ) {}

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
        // One turn is one model call in this harness: a turn is an LLM request
        // plus the tool calls it asked for. Both ceilings are therefore checked
        // against the same counter, and whichever is lower names itself.
        this.check("turns", this.turns, this.spec.limits.maxTurns);
        this.check("model_calls", this.turns, this.spec.limits.maxModelCalls);
        return;
      }

      case "assistant_message": {
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
        await this.write("agent.usage", this.describeUsage(event.usage), {
          turn: event.turn,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          costUsd: this.total.costUsd,
        });
        this.checkCost();
        return;
      }

      case "turn_completed":
        // Deliberately no row. The next `agent.turn_started` says the previous
        // turn ended, and a timeline is read in full on every render.
        return;

      case "session_ended": {
        await this.write("agent.session_ended", `Session ended: ${event.reason}.`, {
          stopReason: event.reason,
          turns: event.turns,
          inputTokens: this.total.inputTokens,
          outputTokens: this.total.outputTokens,
          costUsd: this.total.costUsd,
          ...(event.error ? { error: event.error } : {}),
        });
        return;
      }
    }
  }

  private add(usage: CodingAgentUsage): void {
    this.total.inputTokens += usage.inputTokens;
    this.total.outputTokens += usage.outputTokens;
    this.total.cacheReadTokens += usage.cacheReadTokens;
    this.total.cacheWriteTokens += usage.cacheWriteTokens;
    // Null is contagious, because the sum of the turns that happened to be
    // priced is not the bill. Reporting it as if it were would understate spend
    // by exactly the amount nobody can see.
    this.total.costUsd =
      this.total.costUsd === null || usage.costUsd === null
        ? null
        : this.total.costUsd + usage.costUsd;
  }

  private describeUsage(usage: CodingAgentUsage): string {
    const tokens = `${usage.inputTokens} in / ${usage.outputTokens} out`;
    if (this.total.costUsd !== null) return `${tokens}, $${this.total.costUsd.toFixed(4)} so far.`;
    return `${tokens}. This model has no rate table, so spend cannot be computed.`;
  }

  private check(which: BudgetExceededError["which"], value: number, limit: number): void {
    if (this.breach || value <= limit) return;
    this.breach = new BudgetExceededError(
      `The coding session reached its ${LIMIT_LABELS[which]} ceiling: ${value} of ${limit}.`,
      which,
    );
    void this.writeBreach(value, limit);
  }

  /**
   * The one ceiling that can fail to be enforceable, and the one that says so.
   *
   * A cost ceiling needs a price for the model, and a model outside the
   * harness's catalog has none. Passing silently in that case would be the
   * worst of the three options: the budget would appear on the job, appear in
   * the config, and stop nothing. One event says it out loud, once.
   */
  private checkCost(): void {
    const limit = this.spec.limits.maxCostUsd;
    if (limit === null) return;

    if (this.total.costUsd === null) {
      if (this.warnedAboutCost) return;
      this.warnedAboutCost = true;
      this.ctx.log.warn(
        { sessionId: this.sessionId, maxCostUsd: limit },
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

  /** Every `agent.*` row carries the session id, so two sessions stay separable. */
  private write(
    type: Parameters<PhaseContext["event"]>[0]["type"],
    message: string,
    data: JobEventData,
  ): Promise<void> {
    return this.ctx.event({
      type,
      message,
      data: { ...data, ...(this.sessionId ? { sessionId: this.sessionId } : {}) },
    });
  }
}

const LIMIT_LABELS: Record<BudgetExceededError["which"], string> = {
  cost: "spend",
  model_calls: "model call",
  tool_calls: "tool call",
  turns: "turn",
};

/**
 * What the model knows about the repository before its first tool call.
 *
 * All of it, in fact. The repository is inside a container the host cannot see,
 * so the harness's own context discovery - which reads `AGENTS.md` and the
 * project tree from its working directory - finds a deliberately empty scratch
 * directory and contributes nothing at all. Everything in here is read from
 * inside the sandbox with the same recorded commands every other phase uses, so
 * building the context is itself visible on the timeline.
 *
 * Best effort throughout: a repository whose file listing could not be read is
 * still a repository the model can explore with `bash`, and failing a job over
 * a missing convenience would be absurd.
 */
async function buildContext(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
): Promise<string> {
  const listing = await ctx.exec({
    argv: ["ls", "-1", "-a", repoDir],
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
  });
  ctx.signal.throwIfAborted();
  const plan = listing.exitCode === 0 ? detectPackageManager(splitLines(listing.stdout)) : null;

  const files = await ctx.exec({
    argv: ["git", "ls-files"],
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
  });
  ctx.signal.throwIfAborted();
  const tracked = files.exitCode === 0 ? splitLines(files.stdout) : [];

  return [
    `# The repository you are working in`,
    ``,
    `- Source: ${ctx.job.repoUrl} on branch ${ctx.job.baseBranch}`,
    ...(ctx.job.baseCommitSha ? [`- Commit: ${ctx.job.baseCommitSha}`] : []),
    `- Root directory: ${repoDir}. Every path you use must be inside it; paths outside are`,
    `  refused, and there is nothing outside it for you to want.`,
    ...describeProject(plan),
    ``,
    `# How your tools work here`,
    ``,
    `Your tools run inside a Linux container that holds this repository and nothing else. It has`,
    `no credentials and no access to any model provider. \`bash\` runs as an unprivileged user, so`,
    `\`sudo\` is not available and installing system packages will not work.`,
    ``,
    `The repository's own test suite has NOT been run yet, so you have no baseline result to`,
    `compare against. Run it yourself if you need to know whether something was already broken.`,
    ...describeFiles(tracked),
  ].join("\n");
}

function describeProject(plan: ProjectPlan | null): string[] {
  if (!plan) return [`- Package manager: could not be determined from the repository root.`];
  return [
    `- Package manager: ${plan.name}${plan.lockfile ? ` (${plan.lockfile})` : " (no lockfile)"}`,
    `- Dependencies are already installed.`,
    `- Test command: \`${plan.runScript("test").join(" ")}\``,
  ];
}

function describeFiles(tracked: string[]): string[] {
  if (tracked.length === 0) return [];

  const shown = tracked.slice(0, CONTEXT_FILE_LIMIT);
  const remainder = tracked.length - shown.length;
  return [
    ``,
    `# Tracked files`,
    ``,
    ...shown,
    ...(remainder > 0 ? [`... and ${remainder} more; use \`bash\` to list the rest.`] : []),
  ];
}

/**
 * Reads `jobs.max_cost_usd` into a ceiling, or into "there is not one".
 *
 * The column is `numeric`, which the driver hands back as a string. `Number("")`
 * is zero and `Number(null)` is zero, and a ceiling of zero would stop every
 * session on its first turn while looking exactly like a configured budget.
 * Anything that is not a positive finite number becomes null instead, which the
 * phase reports rather than enforces.
 */
function parseCostCeiling(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
