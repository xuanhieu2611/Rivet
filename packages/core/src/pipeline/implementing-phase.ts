import type { JobEventData } from "@rivet/contracts";

import { AgentSessionTimedOutError } from "../agent/errors";
import type {
  AgentToolbox,
  CodingAgentEvent,
  CodingAgentSpec,
  CodingAgentUsage,
} from "../agent/coding-agent";
import type { BaselineOutcome } from "../events/baseline-log";
import type { AgentUsagePatch } from "../jobs/agent-usage";
import { BudgetExceededError } from "../jobs/failure";
import { truncate } from "../sandbox/command-log";
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
 * What this phase still deliberately does not do is judge the result. It sets
 * the session up to be judgeable - it states the baseline, names the exact test
 * command, and asks for a closing summary - and `testing` forms the opinion by
 * re-running the suite itself. A model saying it is done is a claim, not a
 * result.
 */

/**
 * How much of the file listing the model is given up front.
 *
 * Enough to orient in a normal repository, small enough that a monorepo with
 * fifty thousand files does not spend the entire context window before the
 * first turn. The model has `bash` and can look at the rest.
 */
const CONTEXT_FILE_LIMIT = 300;

/**
 * Three caps rather than one total, and that is the whole reason they are
 * separate constants.
 *
 * PRD §14 step 1 wants the README and the manifest's scripts in the first
 * prompt. Bounded as a shared total, one enormous README would crowd out the
 * scripts block and the file listing - the two things that are almost always
 * more useful than prose. Bounded individually, a repository with a book for a
 * README costs exactly the README's share and nothing else's.
 */
const README_MAX_BYTES = 4_096;
const SCRIPTS_MAX_BYTES = 2_048;

/**
 * The manifest is read with a cap well above the default, for the same reason
 * `baseline-phase.ts` reads it that way: a `package.json` clipped at 64KB is not
 * a smaller manifest, it is invalid JSON.
 */
const MANIFEST_MAX_BYTES = 1_048_576;

/** The candidate root READMEs, in the order they are preferred. */
const README_NAMES = ["README.md", "README.rst", "README.txt", "README"];

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

    // Said out loud because a session that ended on a tool call leaves no
    // summary at all, and that is a property of the run worth being able to see
    // before `finalizing` reports it. Stage 6 turns this into the
    // `implementation_summary` artifact; until then it is a log line rather than
    // a fact quietly held in memory and never mentioned.
    ctx.log.info(
      {
        hasSummary: state.lastAssistantMessage !== undefined,
        summaryBytes: state.lastAssistantMessage
          ? Buffer.byteLength(state.lastAssistantMessage, "utf8")
          : 0,
      },
      "the coding session finished",
    );

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

  /**
   * The last thing the model said, which is the implementation summary.
   *
   * Retained rather than recomputed because the event is already being written -
   * this costs one assignment per message and nothing else. The two alternatives
   * were both rejected for Milestone 5: a `.rivet/summary.md` the model writes
   * adds a file that then has to be excluded from every diff, and a second
   * structured model call adds a second provider dependency inside the phase,
   * which PRD §41 lists as later work.
   *
   * Undefined when the session ended on a tool call, which some do. That is
   * recorded plainly rather than papered over with a synthesized sentence: an
   * invented summary is worse than an admitted absence, because only one of them
   * can be told apart from a real one afterwards.
   */
  lastAssistantMessage: string | undefined;

  private sessionId: string | undefined;
  private turns = 0;
  private toolCalls = 0;
  private warnedAboutCost = false;

  private readonly total: CodingAgentUsage;
  private readonly sessionTotal: CodingAgentUsage = emptyUsage();

  constructor(
    private readonly spec: CodingAgentSpec,
    private readonly ctx: PhaseContext,
  ) {
    // A reclaimed attempt starts from the usage already persisted by its
    // predecessor. Older unit fixtures may not carry the M4 columns, so the
    // undefined fallback is intentional and keeps the phase port-compatible.
    this.total = {
      inputTokens: ctx.job.totalInputTokens ?? 0,
      outputTokens: ctx.job.totalOutputTokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: parseStoredCost(ctx.job.totalCostUsd),
    };
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
        // One turn is one model call in this harness: a turn is an LLM request
        // plus the tool calls it asked for. Both ceilings are therefore checked
        // against the same counter, and whichever is lower names itself.
        this.check("turns", this.turns, this.spec.limits.maxTurns);
        this.check("model_calls", this.turns, this.spec.limits.maxModelCalls);
        return;
      }

      case "assistant_message": {
        // Only a message with something in it. A model that ends on whitespace
        // has said nothing, and keeping that would replace a real summary from
        // an earlier turn with an empty one.
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
        // Persist after every completed turn rather than only at session end.
        // A provider failure, cancellation or budget breach after this point
        // must not erase usage the provider already reported.
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

      case "turn_completed":
        // Deliberately no row. The next `agent.turn_started` says the previous
        // turn ended, and a timeline is read in full on every render.
        return;

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
      // The database column is non-null and has no representation for an
      // unpriced model. Keep the durable total at its last known value while
      // the event stream carries the explicit null that tells the UI spend is
      // not computable.
      ...(this.total.costUsd === null ? {} : { totalCostUsd: this.total.costUsd.toFixed(4) }),
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

function emptyUsage(): CodingAgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

/** Adds one provider report to either the job or current-session total. */
function addUsage(total: CodingAgentUsage, usage: CodingAgentUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  // Null is contagious, because the sum of the turns that happened to be
  // priced is not the bill. Reporting it as if it were would understate spend
  // by exactly the amount nobody can see.
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

  const rootEntries = listing.exitCode === 0 ? splitLines(listing.stdout) : [];
  const readme = await readReadme(ctx, options, repoDir, rootEntries);
  const scripts = await readScripts(ctx, options, repoDir, plan);
  const baseline = await readBaselineOutcome(ctx);

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
    `You do not need to commit anything. Everything you change in the working tree is collected`,
    `as a diff after you finish, so leave your work uncommitted and do not create branches.`,
    ``,
    ...describeBaseline(baseline, testCommand(plan)),
    ``,
    `# When you are done`,
    ``,
    ...describeCompletion(testCommand(plan)),
    ...readme,
    ...scripts,
    ...describeFiles(tracked),
  ].join("\n");
}

/** The exact command the baseline ran, which is the one to re-run. */
function testCommand(plan: ProjectPlan | null): string | null {
  return plan ? plan.runScript("test").join(" ") : null;
}

/**
 * The sentence this stage exists to replace.
 *
 * Until Milestone 5 it read "the test suite has NOT been run yet", which stopped
 * being true the moment the baseline moved to `analyzing`. What replaces it is
 * most of the value of telling the model anything at all: a red baseline says
 * "this failure is the task and it is not your fault", and a green one says
 * "everything passing now has to still pass", and those two produce very
 * different sessions.
 *
 * Null is not `skipped`, and they are worded differently on purpose. `skipped`
 * means `analyzing` looked and there was nothing to run; null means nobody has
 * looked yet, and telling a model no baseline could be established when a test
 * script is sitting right there sends it hunting for a problem that is not real.
 */
function describeBaseline(baseline: BaselineOutcome | null, command: string | null): string[] {
  const rerun = command ? ` with \`${command}\`` : "";

  switch (baseline) {
    case "passed":
      return [
        `# The test baseline`,
        ``,
        `The repository's own test suite was run${rerun} before anything was modified, and it`,
        `PASSED. Nothing here is broken yet, so every test that passes now must still pass when`,
        `you are done. A test that fails after your change is a regression you caused.`,
      ];
    case "failed":
      return [
        `# The test baseline`,
        ``,
        `The repository's own test suite was run${rerun} before anything was modified, and it`,
        `FAILED. That failure was already there and is not your fault - it is almost certainly`,
        `the thing you have been asked to fix. Run the suite yourself to see it, fix the cause`,
        `rather than the test, and do not delete or weaken a test to make it pass.`,
      ];
    case "skipped":
      return [
        `# The test baseline`,
        ``,
        `No baseline could be established: this repository has no runnable test script, or its`,
        `manifest could not be read. Nothing will re-run tests after you finish either, so be`,
        `correspondingly careful, and verify your change however the project allows.`,
      ];
    case null:
      return [
        `# The test baseline`,
        ``,
        `The repository's own test suite has not been run, so there is no baseline result to`,
        `compare against. Run it yourself if you need to know whether something was already`,
        `broken before you touched it.`,
      ];
  }
}

/**
 * The two instructions the rest of the milestone depends on.
 *
 * Neither is enforced here, and that is the design rather than a gap: `testing`
 * re-runs the suite itself and disbelieves the model if it disagrees. What this
 * buys is that the model is likely to have already found the problem the
 * deterministic check would otherwise find first, which is the difference
 * between a session that debugged itself and one that gets marked wrong.
 */
function describeCompletion(command: string | null): string[] {
  return [
    ...(command
      ? [
          `1. Run the test suite yourself - \`${command}\` - and make it pass before you declare`,
          `   the work done. Do not finish on an untested change.`,
        ]
      : [
          `1. Verify your change however this project allows before you declare the work done.`,
          `   There is no test script here to run.`,
        ]),
    `2. End your last turn with a plain message describing what you changed and why. That`,
    `   message is kept as the summary of this run, so write it for a person reading the job`,
    `   afterwards rather than for yourself.`,
  ];
}

function describeProject(plan: ProjectPlan | null): string[] {
  if (!plan) return [`- Package manager: could not be determined from the repository root.`];
  return [
    `- Package manager: ${plan.name}${plan.lockfile ? ` (${plan.lockfile})` : " (no lockfile)"}`,
    `- Dependencies are already installed.`,
    `- Test command: \`${plan.runScript("test").join(" ")}\``,
  ];
}

/**
 * The baseline, or null for every way of not having one.
 *
 * Best effort like everything else in this builder: a database hiccup while
 * reading one event is not a reason to fail a job that has a container, a clone
 * and a model waiting on it. The null wording is honest about not knowing.
 */
async function readBaselineOutcome(ctx: PhaseContext): Promise<BaselineOutcome | null> {
  try {
    return await ctx.readBaseline();
  } catch (error) {
    ctx.log.warn({ err: error }, "could not read the baseline back; the model is told so");
    return null;
  }
}

/**
 * The head of the README, if there is one.
 *
 * The head rather than a head+tail elision, because a README is written to be
 * read from the top: its first few paragraphs say what the project is, and its
 * last few are a licence notice. `head -c` in the container rather than
 * truncating here, so an enormous file is never carried across the sandbox
 * boundary just to be thrown away on this side.
 */
async function readReadme(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
  rootEntries: readonly string[],
): Promise<string[]> {
  const entries = new Set(rootEntries);
  const name = README_NAMES.find((candidate) => entries.has(candidate));
  if (!name) return [];

  const result = await ctx.exec({
    argv: ["head", "-c", String(README_MAX_BYTES), name],
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: README_MAX_BYTES,
  });
  ctx.signal.throwIfAborted();
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) return [];

  return [
    ``,
    `# ${name} (first ${README_MAX_BYTES} bytes)`,
    ``,
    result.stdout.trimEnd(),
    ...(result.stdout.length >= README_MAX_BYTES
      ? [`... truncated; read the rest with \`bash\`.`]
      : []),
  ];
}

/**
 * The manifest's `scripts` block, which is the project's own list of verbs.
 *
 * Only the scripts. The rest of a `package.json` is dependency versions the
 * model can read for itself if it turns out to matter, and pasting all of it
 * would spend the context budget on a lockfile in prose.
 */
async function readScripts(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
  plan: ProjectPlan | null,
): Promise<string[]> {
  if (!plan) return [];

  const result = await ctx.exec({
    argv: ["cat", "package.json"],
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: MANIFEST_MAX_BYTES,
  });
  ctx.signal.throwIfAborted();
  if (result.exitCode !== 0 || result.truncated) return [];

  const scripts = parseScripts(result.stdout);
  if (!scripts) return [];

  const bounded = truncate(JSON.stringify(scripts, null, 2), SCRIPTS_MAX_BYTES);
  return [``, `# package.json scripts`, ``, "```json", bounded.text, "```"];
}

/** The `scripts` object, or null for every shape that is not one. */
function parseScripts(text: string): Record<string, string> | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof manifest !== "object" || manifest === null) return null;

  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return null;

  const entries = Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
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

function parseStoredCost(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
