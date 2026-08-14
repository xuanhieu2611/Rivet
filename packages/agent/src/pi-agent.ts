import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "typebox";
import type * as Pi from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  AgentFailedError,
  type AgentToolbox,
  AgentUnavailableError,
  type CodingAgent,
  type CodingAgentEvent,
  type CodingAgentSession,
  type CodingAgentSpec,
  type CodingAgentStopReason,
  type ImplementerAgentToolbox,
  type PlannerAgentToolbox,
} from "@rivet/core";

import { EventBuffer } from "./event-buffer";
import { emptyUsage, PiEventMapper } from "./event-mapper";
import { createPlannerReadOperations, createToolOperations, withToolCall } from "./tools";

/**
 * The Pi adapter: the only file in Rivet that knows Pi exists.
 *
 * Everything specific to the harness is confined here - its session
 * construction, its tool factories, its event names, the shape of its errors -
 * so that a version bump in a young external dependency is a change to this
 * package rather than to Rivet's domain, its timeline or its database.
 *
 * The topology worth keeping in your head: **the harness runs on the worker
 * host and its tools run in the job's container.** The model key never enters a
 * sandbox that is executing arbitrary cloned code, and the sandbox never learns
 * that a model provider exists. This is not a clever arrangement - Pi ships an
 * extension that does exactly this against a micro-VM, and Rivet's Docker
 * sandbox stands where that micro-VM stands.
 *
 * What that arrangement costs, stated honestly because it is easy to overstate
 * what it buys: the harness process itself is unsandboxed, running as the
 * worker's own user, and Pi documents that it has no permission system. Nothing
 * here contains the *harness*. What is contained is the *model*, and it is
 * contained by the fact that the only capabilities it is given are four tools
 * whose operations all end at the sandbox port - plus one assertion, after
 * construction, that those are the only four tools the session actually holds.
 */

/** The implementer's four tools, sorted because the assertion compares sorted lists. */
export const RIVET_TOOL_NAMES = ["bash", "edit", "read", "write"] as const;
/** The planner's four read-only tools, sorted for the same assertion. */
export const RIVET_PLANNER_TOOL_NAMES = [
  "list_files",
  "read",
  "search_text",
  "submit_plan",
] as const;

/** The slice of a pino logger this adapter uses. Structured first, message second. */
export interface AgentLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export interface PiCodingAgentOptions {
  /** The model id as the provider names it, e.g. `deepseek/deepseek-v4-flash`. */
  model: string;
  /** The provider id in the harness's catalog, e.g. `openrouter`. */
  provider: string;
  /**
   * A Rivet-owned configuration directory, deliberately not `~/.pi`.
   *
   * The harness discovers context from its working directory and its config
   * directory: `AGENTS.md`, `SYSTEM.md`, extensions, settings, skills. Pointed
   * at a developer's own directory it would silently mix that developer's
   * machine into every job this worker runs, which makes a run unreproducible
   * and is close to the most confusing bug available here. Pointed here it
   * finds a deliberately empty world.
   */
  homeDir: string;
  /** Cap on what one shell command may hand back to the model. */
  outputMaxBytes: number;
  /**
   * How many events may wait for the phase before the oldest is dropped.
   *
   * See `EventBuffer`: the harness's subscription offers no backpressure, so
   * something has to state a bound. This one is far above the realistic rate,
   * because the harness spends most of a session awaiting one of Rivet's own
   * tool calls.
   */
  eventBufferCapacity?: number;
  logger?: AgentLogger;
}

/**
 * The SDK, loaded on first use rather than on import.
 *
 * `@rivet/agent` must be importable with no model key, no network and no
 * configuration, the same rule `@rivet/database`, `@rivet/queue` and
 * `@rivet/sandbox` follow - `pnpm build` and `pnpm test` run in CI with none of
 * those. The harness's entry point pulls in a terminal UI, an image codec and
 * every provider it supports, which is both slow and a thing that can throw, so
 * it is loaded inside `start()` and memoised. Every unit test that only wants
 * the fake pays nothing for it.
 */
let piModule: Promise<typeof Pi> | undefined;

function loadPi(): Promise<typeof Pi> {
  piModule ??= import("@earendil-works/pi-coding-agent");
  return piModule;
}

function toolNamesForRole(role: CodingAgentSpec["role"]): readonly string[] {
  return role === "planner" ? RIVET_PLANNER_TOOL_NAMES : RIVET_TOOL_NAMES;
}

function createListFilesTool(pi: typeof Pi, toolbox: PlannerAgentToolbox, signal: AbortSignal) {
  return pi.defineTool({
    name: "list_files",
    label: "List files",
    description: "List tracked repository files for planning. This is read-only.",
    promptSnippet: "List tracked repository files",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, toolSignal) {
      const content = await toolbox.listFiles(toolSignal ?? signal);
      return {
        content: [{ type: "text", text: content || "(no tracked files)" }],
        details: {},
      };
    },
  });
}

function createSearchTextTool(pi: typeof Pi, toolbox: PlannerAgentToolbox, signal: AbortSignal) {
  return pi.defineTool({
    name: "search_text",
    label: "Search text",
    description: "Search tracked repository text for a literal or regular expression pattern.",
    promptSnippet: "Search tracked repository text",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500, description: "The text to search for" }),
    }),
    async execute(_toolCallId, params, toolSignal) {
      const content = await toolbox.searchText(params.query, toolSignal ?? signal);
      return {
        content: [{ type: "text", text: content || "(no matches)" }],
        details: {},
      };
    },
  });
}

function createSubmitPlanTool(pi: typeof Pi, toolbox: PlannerAgentToolbox, signal: AbortSignal) {
  const item = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    minItems: 1,
    maxItems: 12,
  });

  return pi.defineTool({
    name: "submit_plan",
    label: "Submit implementation plan",
    description:
      "Submit the complete structured implementation plan. This must be the planner's final action.",
    promptSnippet: "Submit the structured implementation plan",
    promptGuidelines: [
      "Use submit_plan only after inspecting enough repository evidence.",
      "Include all six sections with concrete, bounded items.",
      "Do not replace submit_plan with an assistant message containing JSON.",
    ],
    parameters: Type.Object({
      problemInterpretation: Type.String({ minLength: 1, maxLength: 4_000 }),
      relevantComponents: item,
      reproductionStrategy: item,
      implementationApproach: item,
      validationPlan: item,
      riskAreas: item,
    }),
    async execute(_toolCallId, params, toolSignal) {
      await toolbox.submitPlan(params, toolSignal ?? signal);
      return {
        content: [{ type: "text", text: "Implementation plan accepted." }],
        details: params,
        terminate: true,
      };
    },
  });
}

export class PiCodingAgent implements CodingAgent {
  constructor(private readonly options: PiCodingAgentOptions) {}

  async start(
    spec: CodingAgentSpec,
    tools: AgentToolbox,
    signal: AbortSignal,
  ): Promise<CodingAgentSession> {
    signal.throwIfAborted();
    const pi = await loadPi();

    await mkdir(this.options.homeDir, { recursive: true });
    // The harness's own working directory, and it is empty on purpose. The
    // repository is inside a container the host cannot see, so pointing the
    // harness at any real directory would only give it a different project's
    // context to be confused by.
    const cwd = await mkdtemp(join(this.options.homeDir, "session-"));

    let fatal: unknown;
    const mapper = new PiEventMapper(spec.previewMaxBytes);
    const customTools: Pi.ToolDefinition[] = [];
    const expectedToolNames = toolNamesForRole(spec.role);

    if (spec.role !== tools.role) {
      await rm(cwd, { recursive: true, force: true });
      throw new AgentFailedError(
        `The ${spec.role} session received the ${tools.role} toolbox. Role and capabilities must match.`,
      );
    }

    const modelRuntime = await pi.ModelRuntime.create({
      // Rivet's own credential file, in Rivet's own directory. The key itself
      // is resolved from the environment by the harness; this only decides
      // where it would look for a stored one, and the answer must not be the
      // developer's.
      authPath: join(this.options.homeDir, "auth.json"),
      // No custom catalog. The configured model ships in the harness's own
      // catalog with its rates, which is also what makes a cost ceiling
      // enforceable rather than aspirational.
      modelsPath: null,
      // A worker starting a session is not the moment to discover that a
      // catalog refresh endpoint is slow.
      allowModelNetwork: false,
    });

    const model = modelRuntime.getModel(this.options.provider, this.options.model);
    if (!model) {
      await rm(cwd, { recursive: true, force: true });
      throw new AgentFailedError(
        `The model provider ${this.options.provider} has no model ${this.options.model}. ` +
          `Fix RIVET_MODEL or RIVET_MODEL_PROVIDER; a retry would ask for the same one.`,
      );
    }

    if (spec.role === "implementer") {
      const implementerTools = tools as ImplementerAgentToolbox;
      const operations = createToolOperations({
        toolbox: implementerTools,
        repoDir: spec.workdir,
        outputMaxBytes: this.options.outputMaxBytes,
        commandTimeoutMs: spec.commandTimeoutMs,
        signal,
        onFatal: (error) => {
          fatal ??= error;
        },
        onCommand: (toolCallId, command) => {
          if (toolCallId) mapper.recordCommand(toolCallId, command.commandExecutionId);
        },
      });

      const bashTool = pi.createBashToolDefinition(spec.workdir, {
        operations: operations.bash,
        exposeSessionEnvironment: false,
      });
      const bash = {
        ...bashTool,
        execute: (
          toolCallId: string,
          params: Parameters<typeof bashTool.execute>[1],
          abort: Parameters<typeof bashTool.execute>[2],
          onUpdate: Parameters<typeof bashTool.execute>[3],
          ctx: Parameters<typeof bashTool.execute>[4],
        ) =>
          withToolCall(toolCallId, () =>
            bashTool.execute(toolCallId, params, abort, onUpdate, ctx),
          ),
      };

      customTools.push(
        pi.defineTool(pi.createReadToolDefinition(spec.workdir, { operations: operations.read })),
        pi.defineTool(pi.createWriteToolDefinition(spec.workdir, { operations: operations.write })),
        pi.defineTool(pi.createEditToolDefinition(spec.workdir, { operations: operations.edit })),
        pi.defineTool(bash),
      );
    } else {
      const plannerTools = tools as PlannerAgentToolbox;
      const readOperations = createPlannerReadOperations({
        toolbox: plannerTools,
        repoDir: spec.workdir,
        signal,
        onFatal: (error) => {
          fatal ??= error;
        },
      });

      customTools.push(
        pi.defineTool(pi.createReadToolDefinition(spec.workdir, { operations: readOperations })),
        createListFilesTool(pi, plannerTools, signal),
        createSearchTextTool(pi, plannerTools, signal),
        createSubmitPlanTool(pi, plannerTools, signal),
      );
    }

    const { session } = await pi.createAgentSession({
      cwd,
      agentDir: this.options.homeDir,
      model,
      modelRuntime,
      // No session file, no resume. Resumption is Milestone 8's problem and
      // inventing a checkpoint format nothing reads is how it stops being one.
      sessionManager: pi.SessionManager.inMemory(),

      // An explicit allowlist, and deliberately **not** `noTools: "all"`.
      // It names both built-ins and custom tools. Custom tools are registered
      // below, and no harness default outside this role's list can become active
      // accidentally.
      tools: [...expectedToolNames],
      customTools,
    });

    // The assertion the containment argument rests on.
    //
    // Not decoration, and not "we configured it correctly": this is the
    // difference between believing no host-side tool survived and knowing it.
    // A harness version that ships a new default tool, or that changes how an
    // allowlist and a custom registry interact, fails one job loudly here
    // instead of quietly handing a model a shell on the worker.
    const active = [...session.getActiveToolNames()].sort();
    if (active.join(",") !== [...expectedToolNames].join(",")) {
      session.dispose();
      await rm(cwd, { recursive: true, force: true });
      throw new AgentFailedError(
        `The ${spec.role} session came up holding [${active.join(", ")}] instead of ` +
          `[${expectedToolNames.join(", ")}]. Every tool a session holds must run inside the ` +
          `job's sandbox, so this one is refused rather than run.`,
      );
    }

    return new PiSession({
      session,
      cwd,
      mapper,
      spec,
      model: this.options.model,
      provider: this.options.provider,
      toolNames: active,
      capacity: this.options.eventBufferCapacity ?? 1_024,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      readFatal: () => fatal,
    });
  }
}

interface PiSessionOptions {
  session: AgentSession;
  cwd: string;
  mapper: PiEventMapper;
  spec: CodingAgentSpec;
  model: string;
  provider: string;
  toolNames: string[];
  capacity: number;
  logger?: AgentLogger;
  readFatal: () => unknown;
}

class PiSession implements CodingAgentSession {
  readonly id: string;
  private stopped = false;

  constructor(private readonly options: PiSessionOptions) {
    this.id = options.session.sessionId;
  }

  run(signal: AbortSignal): AsyncIterable<CodingAgentEvent> {
    const { session, mapper, logger } = this.options;

    const buffer = new EventBuffer<CodingAgentEvent>({
      capacity: this.options.capacity,
      onDrop: (dropped) => {
        logger?.warn(
          { sessionId: this.id, dropped },
          "the coding session produced events faster than they could be recorded; the timeline is incomplete",
        );
      },
    });

    buffer.push({
      type: "session_started",
      sessionId: this.id,
      model: this.options.model,
      provider: this.options.provider,
      toolNames: this.options.toolNames,
    });

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      for (const mapped of mapper.map(event)) buffer.push(mapped);
    });

    // The harness's own abort is the only handle on a run in progress: `prompt`
    // takes no signal. Aborting it settles the promise below, which is what
    // lets a cancelled job stop within a heartbeat rather than at the end of
    // whatever the model was in the middle of.
    const onAbort = () => {
      void session.abort().catch(() => undefined);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    void this.drive(buffer, signal)
      .catch((error: unknown) => buffer.fail(error))
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
        unsubscribe();
      });

    return buffer;
  }

  /**
   * Runs the task and works out what to call the ending.
   *
   * The subtlety this exists for: `prompt()` resolving does not mean the run
   * succeeded. A provider failure comes back as a normal return with the final
   * assistant message carrying `stopReason: "error"`, so a caller that only
   * watches for exceptions sees a session that quietly did nothing. The reason
   * is therefore assembled from three sources - a thrown error, the fatal slot
   * the tool layer writes to, and the harness's own stop reason - in that order
   * of authority.
   */
  private async drive(buffer: EventBuffer<CodingAgentEvent>, signal: AbortSignal): Promise<void> {
    const { session, mapper, spec } = this.options;

    let thrown: unknown;
    try {
      await session.prompt(buildPrompt(spec));
    } catch (error) {
      thrown = error;
    }

    const fatal = this.options.readFatal();
    const progress = mapper.progress;

    // A sandbox that stopped working outranks everything else, including a
    // model that reported an error afterwards: the model's error is almost
    // certainly a description of the same event, one step further downstream.
    // A rethrow of the tool layer's own error rather than a new one: it is
    // already a `TerminalJobError` carrying the right failure category, and
    // wrapping it would replace `command_timed_out` with something vaguer.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (fatal !== undefined) throw fatal;

    if (thrown !== undefined) throw classifyHarnessError(thrown);

    const reason = this.stopReason(signal, progress.aborted, progress.failure);
    buffer.push({
      type: "session_ended",
      reason,
      turns: progress.turns,
      usage: progress.turns === 0 ? emptyUsage() : progress.usage,
      ...(progress.failure ? { error: progress.failure } : {}),
    });

    // Failed rather than closed, and the order is the point: the queued
    // `session_ended` is drained before the failure surfaces, so the timeline
    // records how the session ended before the job records why it failed.
    // Throwing here instead would be swallowed - the buffer is already ending,
    // and a closed buffer ignores everything, including a late failure.
    if (reason === "error" && progress.failure) {
      buffer.fail(classifyHarnessError(new Error(progress.failure)));
      return;
    }

    buffer.close();
  }

  private stopReason(
    signal: AbortSignal,
    aborted: boolean,
    failure: string | undefined,
  ): CodingAgentStopReason {
    if (signal.aborted || aborted) return "aborted";
    if (failure) return "error";
    return "completed";
  }

  /**
   * Idempotent, and never throws. The same contract as `Sandbox.destroy`, for
   * the same reason: this runs in `finally` blocks that are already carrying
   * the failure that got them there.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    try {
      await this.options.session.abort();
    } catch {
      // Already idle, already disposed, or already gone.
    }
    try {
      this.options.session.dispose();
    } catch {
      // As above.
    }
    try {
      await rm(this.options.cwd, { recursive: true, force: true });
    } catch (error) {
      this.options.logger?.warn(
        { sessionId: this.id, err: error },
        "could not remove the session's scratch directory",
      );
    }
  }
}

/**
 * What the model is asked to do.
 *
 * The context comes first and it is not padding. The repository is inside a
 * container the host cannot see, so the harness's own context discovery finds
 * an empty directory and contributes nothing at all - what the model knows
 * before its first tool call is exactly what is in here.
 */
function buildPrompt(spec: CodingAgentSpec): string {
  return [spec.context, "", `# Task: ${spec.task.title}`, "", spec.task.description].join("\n");
}

/**
 * Sorts a harness or provider failure into retryable and terminal.
 *
 * The default is terminal, which is the same choice `classify()` makes in the
 * domain and for the same reason: retrying an error nobody has reasoned about
 * turns one bug into three identical bugs, a tripled bill, and a timeline three
 * times as hard to read. Retryability is a claim, and it has to be made
 * deliberately.
 *
 * Matching on message text is unpleasant and it is what is available: the
 * harness normalises provider errors into `Error` before Rivet sees them.
 * Keeping the matching in this file is the point - it is exactly the kind of
 * thing that breaks on a version bump, and this is the package that is allowed
 * to break on one.
 */
export function classifyHarnessError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (
    /\b(429|500|502|503|504|529)\b|rate.?limit|overloaded|capacity|temporarily|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(
      message,
    )
  ) {
    return new AgentUnavailableError(`The model provider could not be reached: ${message}`, {
      cause: error,
    });
  }

  return new AgentFailedError(`The coding session could not run: ${message}`, { cause: error });
}
