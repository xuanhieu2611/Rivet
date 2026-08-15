import type { ImplementationPlan, ReviewIssue, ReviewReport } from "@rivet/contracts";
import type {
  AgentToolbox,
  CodingAgent,
  CodingAgentEvent,
  CodingAgentSession,
  CodingAgentSpec,
  CodingAgentUsage,
  ImplementerAgentToolbox,
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
  events?: CodingAgentEvent[];
  /** A valid plan submitted automatically when this is used for a planner. */
  plan?: ImplementationPlan | null;
  /**
   * The verdict submitted automatically when this is used for a reviewer.
   *
   * Three states rather than two, and the third is the one worth having.
   * Omitted means a default approval. A report means that verdict. **`null`
   * means the session ends without calling `submit_review` at all**, which is
   * the `review_not_produced` path - a session that talked and submitted
   * nothing, which must never be read as an approval.
   */
  review?: ReviewReport | null;
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
  useTools?: (tools: ImplementerAgentToolbox, signal: AbortSignal) => Promise<void>;
}

export interface FakeCodingAgentOptions {
  /** One entry per implementation session, in the order they are started. */
  script?: ScriptedSession[];
  /** The planning session, or a deterministic valid plan when omitted. */
  plannerScript?: ScriptedSession;
  /**
   * The review sessions, in the order they are started - one per loop.
   *
   * A single object is used for every review session. An array is consumed in
   * order and **its last entry repeats** once the array is exhausted, which is
   * what makes the three scripts the review loop needs one line each:
   *
   * ```ts
   * reviewerScript: { review: approvingReview() }                   // approve on the first loop
   * reviewerScript: [{ review: revisingReview() }, { review: approvingReview() }]  // revise once, then approve
   * reviewerScript: { review: revisingReview() }                    // revise every time, to the bound
   * reviewerScript: { review: null }                                // end without submitting a review
   * ```
   *
   * Repeating rather than falling back to the default approval, because the
   * bound is enforced by Rivet rather than by the reviewer changing its mind:
   * a script that runs out and quietly starts approving would make an exhausted
   * loop untestable by making it impossible.
   */
  reviewerScript?: ScriptedSession | ScriptedSession[];
  /** Every `start()` fails with this. */
  startFails?: Error;
}

const DEFAULT_PLAN: ImplementationPlan = {
  problemInterpretation: "The requested change needs a focused repository investigation.",
  relevantComponents: ["The files implicated by the task"],
  reproductionStrategy: ["Run the repository baseline and a targeted check"],
  implementationApproach: ["Make the smallest evidence-based change"],
  validationPlan: ["Run the targeted test suite"],
  riskAreas: ["Existing behavior outside the requested path"],
};

const DEFAULT_BLOCKING_ISSUE: ReviewIssue = {
  title: "The change does not cover the case the issue names",
  detail:
    "The issue names a boundary the patch does not handle, and the tests do not exercise it. " +
    "Handle it and cover it.",
  paths: [],
  category: "incomplete",
};

/**
 * A valid approval, for the scripts that want the loop to end.
 *
 * Built here rather than written out in every test because the cross-field rule
 * is real: an approval carrying a blocking issue is refused by the schema, so a
 * test that hand-rolls one gets a validation failure instead of the path it
 * meant to exercise.
 */
export function approvingReview(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    decision: "approve",
    blockingIssues: [],
    nonBlockingIssues: [],
    confidence: 0.9,
    summary: "The change matches the issue and the validation report supports it.",
    ...overrides,
  };
}

/** A valid revision request, with the one blocking issue the schema insists on. */
export function revisingReview(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    decision: "revise",
    blockingIssues: [DEFAULT_BLOCKING_ISSUE],
    nonBlockingIssues: [],
    confidence: 0.8,
    summary: "The change is close, and one blocking finding has to be addressed first.",
    ...overrides,
  };
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
    if (spec.role !== tools.role) {
      return Promise.reject(
        new Error(`The ${spec.role} session received the ${tools.role} toolbox.`),
      );
    }

    const implementationIndex = this.starts.filter((start) => start.role === "implementer").length;
    const reviewIndex = this.starts.filter((start) => start.role === "reviewer").length;
    this.starts.push(spec);

    const scriptedPlanner = this.options.script?.[0];
    const script =
      spec.role === "planner"
        ? (this.options.plannerScript ??
          (scriptedPlanner?.plan !== undefined
            ? scriptedPlanner
            : { events: [], plan: DEFAULT_PLAN }))
        : spec.role === "reviewer"
          ? this.reviewerScript(reviewIndex)
          : (this.options.script?.[implementationIndex] ?? { events: [] });
    const session = new FakeCodingAgentSession(`fake-session-${this.nextId++}`, script, tools);
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  /** The script for review session `index`, with the last entry repeating. */
  private reviewerScript(index: number): ScriptedSession {
    const scripted = this.options.reviewerScript;
    if (scripted === undefined) return { events: [] };
    if (!Array.isArray(scripted)) return scripted;
    if (scripted.length === 0) return { events: [] };
    return scripted[Math.min(index, scripted.length - 1)] ?? { events: [] };
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

    if (this.tools.role === "planner" && this.script.plan !== null) {
      const plan = this.script.plan ?? DEFAULT_PLAN;
      await this.tools.submitPlan(plan, signal);
    }
    if (this.tools.role === "reviewer" && this.script.review !== null) {
      await this.tools.submitReview(this.script.review ?? approvingReview(), signal);
    }
    if (this.tools.role === "implementer" && this.script.useTools) {
      await this.script.useTools(this.tools, signal);
    }

    let turns = 0;
    let usage = emptyUsage();
    for (const event of this.script.events ?? []) {
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
