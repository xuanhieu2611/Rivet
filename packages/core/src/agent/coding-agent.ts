/**
 * The coding-agent PORT: what the domain needs from a model-driven coding
 * harness, and nothing more.
 *
 * Types and an interface, no implementation, for exactly the reason
 * `queue/job-queue.ts` and `sandbox/sandbox.ts` are types and an interface: the
 * moment `@rivet/core` imports `@earendil-works/pi-coding-agent`, the package
 * stops being runnable by anything without a model provider, and `pnpm test`
 * stops being something CI can run on a bare machine with no key.
 * `packages/agent` supplies two implementations - the Pi adapter for the real
 * system, and a scripted fake for tests.
 *
 * The port is deliberately much smaller than Pi. It knows about starting a
 * session, watching what it does, and stopping it. It does not know about
 * models, providers, prompts, token streams, compaction or retries, because
 * none of those are things the domain has an opinion about - they are the
 * adapter's problem, and confining them there is what keeps a version bump in a
 * young external dependency from being a change to Rivet's domain.
 *
 * Read this alongside `PhaseContext`: a session's effects on the world all
 * arrive through the `AgentToolbox` the phase supplies, so the agent can only
 * do what the phase already knows how to record.
 */

import type { RecordedCommand } from "../pipeline/phase-context";

/**
 * Everything needed to run one coding session.
 *
 * Every bound is a required field rather than an optional one with a default,
 * the same rule `SandboxSpec` follows and for the same reason: a default here
 * would be policy in the package that holds no policy, and the failure mode of
 * a forgotten ceiling is a session that runs until someone notices the bill.
 * `apps/worker` reads these from the environment and passes them in.
 */
export interface CodingAgentSpec {
  /** The repository directory, as an absolute path inside the sandbox. */
  workdir: string;
  /** What the agent is being asked to do. Built by the phase, never by the adapter. */
  task: CodingAgentTask;
  /**
   * Extra instructions Rivet prepends: the repository tree, the detected
   * package manager and test command, the baseline result.
   *
   * This exists because the repository is not on the host, so the harness's own
   * context discovery finds an empty directory and contributes nothing. What
   * the model knows about the repository before its first tool call is exactly
   * what is in here.
   */
  context: string;
  /**
   * Hard stop for the whole session, distinct from the job's own deadline.
   *
   * A job that is merely slow and a session that has stopped making progress
   * are different failures. This one is the session's.
   */
  sessionTimeoutMs: number;
  /** Per-command budget for the shell tool, handed to `AgentToolbox.exec`. */
  commandTimeoutMs: number;
  /**
   * Cap on any single piece of text this session puts on the timeline.
   *
   * Bounded here rather than at the point of writing because the adapter is
   * what turns a harness event into a Rivet event, and an unbounded assistant
   * message or tool result reaching `job_events` would break Milestone 3's
   * property that a timeline is cheap to read in full. What the *model* sees is
   * a different bound and belongs to the tool layer, not here.
   */
  previewMaxBytes: number;
  limits: CodingAgentLimits;
}

export interface CodingAgentTask {
  title: string;
  description: string;
}

/**
 * The ceilings a session is stopped at, from PRD §17.
 *
 * Enforced by the phase between turns, never inside the adapter, so that every
 * harness gets the same budget behaviour rather than whatever its author
 * happened to implement.
 */
export interface CodingAgentLimits {
  maxTurns: number;
  maxToolCalls: number;
  maxModelCalls: number;
  /**
   * Null when spend cannot be computed for the configured model.
   *
   * Not zero, and the distinction matters: zero would be a budget of nothing,
   * while null is "no rate table, so this ceiling cannot be enforced" - which
   * the phase says out loud in an event rather than passing silently.
   */
  maxCostUsd: number | null;
}

/** What one turn cost, as reported by the provider. */
export interface CodingAgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when the harness cannot price the model. See `CodingAgentLimits.maxCostUsd`. */
  costUsd: number | null;
}

/** Why a session stopped, in Rivet's vocabulary rather than the harness's. */
export type CodingAgentStopReason =
  /** The model finished on its own. Says nothing about whether the work is any good. */
  | "completed"
  /** Cancellation, job timeout, or the session's own deadline. */
  | "aborted"
  /** A ceiling in `CodingAgentLimits` was reached. */
  | "budget"
  /** The harness or the provider failed. The phase classifies it; the adapter reports it. */
  | "error";

/**
 * What Rivet is willing to persist about a session.
 *
 * A discriminated union of Rivet's own events, deliberately NOT a passthrough
 * of the harness's event stream. Mapping one onto the other is the adapter's
 * job, and that mapping is where the version risk of a young dependency is
 * contained: Pi shipping a new event type is a change to `packages/agent`, not
 * to the timeline, the database, or the browser.
 *
 * Two absences are load-bearing. There is no token-delta event, because a
 * `job_events` row per streamed token would destroy Milestone 3's guarantee of
 * a bounded query per second per viewer and make the timeline unreadable. And
 * there is no event for a tool's full output, because the transcript already
 * lives in `job_commands` for shell commands and nowhere at all for the rest.
 */
export type CodingAgentEvent =
  | {
      type: "session_started";
      sessionId: string;
      model: string;
      provider: string;
      /** The tools actually active on the session, which is what the assertion in the adapter checks. */
      toolNames: string[];
    }
  | { type: "turn_started"; turn: number }
  /** One completed assistant message, already truncated to `previewMaxBytes`. Never a delta. */
  | { type: "assistant_message"; turn: number; text: string }
  | {
      type: "tool_started";
      turn: number;
      toolCallId: string;
      toolName: string;
      /** A bounded rendering of the arguments, for the timeline. Not the arguments themselves. */
      argsPreview: string;
      /**
       * Set when this tool call went through `AgentToolbox.exec`.
       *
       * It is the same correlation id `PhaseContext.exec` puts on
       * `command.started`, which is what lets the UI pair a tool call with the
       * command transcript it produced instead of duplicating the output.
       */
      commandExecutionId?: string;
    }
  | {
      type: "tool_completed";
      turn: number;
      toolCallId: string;
      toolName: string;
      /** A tool error is a result the model reads and reacts to, never an exception. */
      isError: boolean;
      durationMs: number;
      resultPreview: string;
      commandExecutionId?: string;
    }
  /** One per turn, never one per delta. */
  | { type: "usage"; turn: number; usage: CodingAgentUsage }
  | { type: "turn_completed"; turn: number }
  | {
      type: "session_ended";
      reason: CodingAgentStopReason;
      turns: number;
      /** Cumulative across the session, for the one row that states the total. */
      usage: CodingAgentUsage;
      /** Present when `reason` is `error`, as the message the phase will classify. */
      error?: string;
    };

/**
 * What a session's tools are allowed to do.
 *
 * Supplied by the phase, which is the entire containment story: the harness
 * runs on the worker host, holding the model key, with no permission system of
 * its own, and the only reason that is acceptable is that every action it can
 * take goes through these three methods and therefore into the job's container.
 * An adapter that reaches for `node:fs` or `child_process` has defeated this,
 * and no test can tell you that - reviewing the adapter is what tells you that.
 *
 * Three methods rather than the six or seven a harness's tool set wants,
 * because the rest are compositions: "does this file exist and can I read it"
 * is a `readFile` that throws, and "make this directory" is implied by
 * `writeFile`, which creates the parents it needs. Every method that is missing
 * here is a capability the model does not have.
 */
export interface AgentToolbox {
  /**
   * Reads a file from inside the sandbox.
   *
   * `truncated` rather than an error for a large file: a model that asked for a
   * 40MB log should be told it got the first part of one, not have its session
   * fail. The bound itself is the phase's, from configuration.
   */
  readFile(path: string, signal: AbortSignal): Promise<AgentFileRead>;

  /** Writes a file inside the sandbox, creating parent directories as needed. */
  writeFile(path: string, content: string, signal: AbortSignal): Promise<void>;

  /**
   * Runs a command in the sandbox, exactly as a Rivet phase would.
   *
   * Deliberately the phase's own `ctx.exec`, which is why an agent's shell
   * commands produce the same `command.started` / `command.completed` events
   * and the same `job_commands` transcript row that `provisioning` produces,
   * with no new event types and no second code path. A shell command the model
   * ran and a shell command Rivet ran are the same kind of fact about the job,
   * and they should be indistinguishable on the timeline.
   */
  exec(input: AgentExecInput): Promise<RecordedCommand>;
}

export interface AgentFileRead {
  content: string;
  /** The file was longer than the phase's cap and `content` is a prefix of it. */
  truncated: boolean;
}

export interface AgentExecInput {
  /**
   * The command as an argument vector, never a shell string - the same rule the
   * sandbox port states, unweakened.
   *
   * A shell tool's whole purpose is to interpret a shell command, so the model's
   * command arrives here as a single element of this array (`["bash", "-lc",
   * command]`) and is interpreted by the container's shell, inside the
   * container. Rivet still never builds a shell string, and there is still no
   * shell anywhere in the host-side path.
   */
  argv: string[];
  cwd: string;
  timeoutMs: number;
}

/**
 * One live session. Created once per attempt, never shared, never resumed.
 *
 * Resumption is Milestone 8's problem and adding it here now would be inventing
 * a checkpoint format nothing writes.
 */
export interface CodingAgentSession {
  /** The harness's identifier for it, recorded on `session_started`. */
  readonly id: string;

  /**
   * Runs the task to completion or to a stop condition.
   *
   * An async iterable rather than a subscribe callback, and that is a
   * correctness choice rather than a stylistic one: each event may be written
   * to Postgres, and a callback that outruns the database is an unbounded
   * buffer with a schedule. Iterating gives the phase backpressure over its own
   * writes. An adapter over a callback-based harness has to bridge the two, and
   * the bound on that bridge is the adapter's to state.
   *
   * Never throws for a tool error - a failed tool is something the model reads
   * and reacts to. It throws when the session itself cannot continue, which is
   * the case the phase classifies into a failure category.
   */
  run(signal: AbortSignal): AsyncIterable<CodingAgentEvent>;

  /**
   * Stops the session and releases whatever it holds. Idempotent, and **never
   * throws** - the same contract as `Sandbox.destroy`, for the same reason.
   *
   * This is called from `finally` blocks that are already carrying the failure
   * that got them there, and a cleanup error that masks the original one turns
   * a two-minute diagnosis into an hour.
   */
  stop(): Promise<void>;
}

export interface CodingAgent {
  /**
   * Builds a session and verifies it before handing it back.
   *
   * "Verifies" is not decoration. An adapter must assert that the tools the
   * session will actually offer the model are exactly the ones backed by the
   * toolbox above, and fail the job otherwise. A harness that quietly retains a
   * host-side default tool is a model with a shell on the worker, and the
   * difference between believing that cannot happen and knowing it did not is
   * one assertion at exactly this point.
   */
  start(
    spec: CodingAgentSpec,
    tools: AgentToolbox,
    signal: AbortSignal,
  ): Promise<CodingAgentSession>;
}
