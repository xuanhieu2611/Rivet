import type {
  AgentToolbox,
  CodingAgent,
  CodingAgentEvent,
  CodingAgentSession,
  CodingAgentSpec,
  CodingAgentUsage,
} from "@rivet/core";

/**
 * A `CodingAgent` that is a list of canned events.
 *
 * The equivalent of `FakeSandbox` and `InMemoryJobQueue`, and it exists for the
 * same reason: this is what keeps `pnpm test` and `pnpm test:integration`
 * runnable with no model key, no network and no third-party inference provider
 * having a bad ten minutes. That is not a convenience. A test suite that fails
 * when someone else's service is slow is a test suite people learn to ignore,
 * and it would be the second-worst thing this milestone could produce.
 *
 * Where this and the Pi adapter disagree, this one is the liar. Nothing
 * asserted against a script here is evidence about a real session; the smoke
 * script is what proves the adapter, and it stays out of CI on purpose.
 */

export interface ScriptedSession {
  /** Yielded in order, before the script's own ending. */
  events: CodingAgentEvent[];
  /** Thrown instead of finishing, for the provider-failure paths. */
  throws?: Error;
  /** Awaited before each event, so a test can interleave a cancel. */
  delayMs?: number;
  /**
   * Never finishes on its own.
   *
   * Waits for the run's abort signal, then ends the way a cancelled session
   * does. This is how the cancellation and job-timeout paths are exercised
   * without a session that genuinely takes ten minutes.
   */
  hang?: boolean;
  /**
   * Runs against the real toolbox before the events are yielded.
   *
   * The one thing a canned event list cannot do is prove that a tool call
   * reaches the sandbox. A script that wants to exercise the toolbox - write a
   * file, run a command, watch a `job_commands` row appear - does it here.
   */
  useTools?: (tools: AgentToolbox, signal: AbortSignal) => Promise<void>;
}

export interface FakeCodingAgentOptions {
  /** One entry per session, in the order they are started. */
  script?: ScriptedSession[];
  /** Every `start()` fails with this. */
  startFails?: Error;
}

export class FakeCodingAgent implements CodingAgent {
  /** Every spec passed to `start`, in order. */
  readonly starts: CodingAgentSpec[] = [];

  /** Every session handed out, including the stopped ones. */
  readonly sessions: FakeCodingAgentSession[] = [];

  private nextId = 1;

  constructor(private readonly options: FakeCodingAgentOptions = {}) {}

  start(
    spec: CodingAgentSpec,
    tools: AgentToolbox,
    signal: AbortSignal,
  ): Promise<CodingAgentSession> {
    // Rejecting rather than throwing synchronously, so a caller writing
    // `agent.start(...).catch(...)` does not also have to wrap the call.
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    if (this.options.startFails) return Promise.reject(this.options.startFails);

    const index = this.starts.length;
    this.starts.push(spec);

    const session = new FakeCodingAgentSession(
      `fake-session-${this.nextId++}`,
      this.options.script?.[index] ?? { events: [] },
      tools,
    );
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

export class FakeCodingAgentSession implements CodingAgentSession {
  /** How many times `stop()` was called, to prove it is idempotent. */
  stopCount = 0;

  constructor(
    readonly id: string,
    private readonly script: ScriptedSession,
    private readonly tools: AgentToolbox,
  ) {}

  get stopped(): boolean {
    return this.stopCount > 0;
  }

  async *run(signal: AbortSignal): AsyncIterable<CodingAgentEvent> {
    signal.throwIfAborted();

    if (this.script.useTools) await this.script.useTools(this.tools, signal);

    let turns = 0;
    let usage = emptyUsage();
    for (const event of this.script.events) {
      if (this.script.delayMs) await pause(this.script.delayMs, signal);
      signal.throwIfAborted();
      if (event.type === "turn_started") turns += 1;
      if (event.type === "usage") usage = addUsage(usage, event.usage);
      yield event;
    }

    if (this.script.hang) {
      await waitForAbort(signal);
      // The real Pi adapter reports an aborted session before its run ends. The
      // fake has to do the same or an integration test that cancels a job would
      // be testing a fake-only omission rather than the phase's lifecycle.
      yield { type: "session_ended", reason: "aborted", turns, usage };
      signal.throwIfAborted();
      return;
    }

    if (this.script.throws) throw this.script.throws;
  }

  stop(): Promise<void> {
    this.stopCount += 1;
    return Promise.resolve();
  }
}

/** Sleeps, unless the run is stopped first, in which case it returns early. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
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

function addUsage(total: CodingAgentUsage, next: CodingAgentUsage): CodingAgentUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    costUsd: total.costUsd === null || next.costUsd === null ? null : total.costUsd + next.costUsd,
  };
}
