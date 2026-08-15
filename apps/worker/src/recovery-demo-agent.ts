import type { ImplementationPlan } from "@rivet/contracts";
import type {
  AgentToolbox,
  CodingAgent,
  CodingAgentEvent,
  CodingAgentSession,
  CodingAgentSpec,
  ImplementerAgentToolbox,
  PlannerAgentToolbox,
} from "@rivet/core";

/**
 * The scripted planner and implementer behind `pnpm demo:recovery`.
 *
 * Everything here is deliberate about one thing: the demo must fail when
 * recovery fails, and for no other reason. A real model would make the run
 * prove two claims at once - that Pi can fix the fixture, and that a killed
 * worker resumes - and a flaky first claim would keep taking the second one
 * down with it. `demo:job` already proves the model half against this same
 * repository with a real session.
 *
 * The two implementation sessions are told apart by the recovery block the
 * `implementing` phase puts in their context, not by a counter in this process:
 * worker A and worker B are separate processes that each load this module
 * fresh, so a counter would give both of them session one. The block can only
 * be there when the newest checkpoint is an `agent_turn` row from a previous
 * attempt, which is exactly the condition the demo is trying to demonstrate.
 *
 * Session one edits the fixture and then never ends. Session two makes **no
 * edit at all** - it reads the restored file, refuses to continue if the fix is
 * not already there, runs the suite and says what happened. That is the point:
 * the job can only reach `completed` with a `fixed` validation outcome if the
 * bytes worker A wrote were captured, restored into a different container, and
 * verified. If restoration silently did nothing, validation fails the job with
 * `no_changes_produced` rather than quietly passing.
 */

/** The sentence `describeRecovery` opens its block with. */
const RECOVERY_MARKER = "You are continuing an interrupted attempt";

const SOURCE_FILE = "src/discount.js";
const BUG = "return quantity > BULK_THRESHOLD;";
const FIX = "return quantity >= BULK_THRESHOLD;";

const PLAN: ImplementationPlan = {
  problemInterpretation:
    "The pricing spec says an order of BULK_THRESHOLD items or more qualifies for the bulk " +
    "discount, but qualifiesForBulkDiscount compares with a strict greater-than, so an order " +
    "of exactly the threshold is charged full price.",
  relevantComponents: [
    "src/discount.js - qualifiesForBulkDiscount, the comparison that decides the boundary",
    "test/discount.test.js - the failing boundary case at exactly BULK_THRESHOLD",
  ],
  reproductionStrategy: [
    "Run the repository suite with `npm test` and read the failing boundary assertion",
  ],
  implementationApproach: [
    "Change the comparison in qualifiesForBulkDiscount from `>` to `>=`",
    "Leave BULK_THRESHOLD, the rounding and the input validation alone",
  ],
  validationPlan: ["Re-run `npm test` and confirm the boundary case passes with nothing regressed"],
  riskAreas: [
    "Weakening a test instead of the code would hide the bug rather than fix it",
    "totalCents shares the same predicate, so the boundary order's total changes with it",
  ],
};

export function createCodingAgent(): CodingAgent {
  return new RecoveryDemoAgent();
}

class RecoveryDemoAgent implements CodingAgent {
  start(
    spec: CodingAgentSpec,
    tools: AgentToolbox,
    signal: AbortSignal,
  ): Promise<CodingAgentSession> {
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    if (spec.role !== tools.role) {
      return Promise.reject(
        new Error(`The ${spec.role} session received the ${tools.role} toolbox.`),
      );
    }

    if (tools.role === "planner") {
      return Promise.resolve(new PlannerSession(spec, tools));
    }
    if (tools.role === "implementer") {
      return Promise.resolve(
        new ImplementerSession(spec, tools, spec.context.includes(RECOVERY_MARKER)),
      );
    }
    // The demo proves crash recovery, not review, so it plays no reviewer
    // session. Refusing loudly beats a session that returns nothing and looks
    // like a reviewer with no findings.
    return Promise.reject(new Error(`The recovery demo agent has no ${tools.role} session.`));
  }
}

class PlannerSession implements CodingAgentSession {
  readonly id = "demo-planner-session";

  constructor(
    private readonly spec: CodingAgentSpec,
    private readonly tools: PlannerAgentToolbox,
  ) {}

  async *run(signal: AbortSignal): AsyncIterable<CodingAgentEvent> {
    signal.throwIfAborted();
    yield started(this.id, ["list_files", "read", "search_text", "submit_plan"]);
    yield { type: "turn_started", turn: 0 };

    // Read-only, through the planner's own capabilities, so the demo's plan is
    // at least grounded in the file it names.
    await this.tools.listFiles(signal);
    // Absolute, because the toolbox hands the path straight to the sandbox: the
    // path resolution a model's tool call gets is the adapter's, not the port's.
    await this.tools.readFile(`${this.spec.workdir}/${SOURCE_FILE}`, signal);
    await this.tools.submitPlan(PLAN, signal);

    yield { type: "usage", turn: 0, usage: usage(1_200, 400, 0.0004) };
    yield { type: "turn_completed", turn: 0 };
    yield {
      type: "session_ended",
      reason: "completed",
      turns: 1,
      usage: usage(1_200, 400, 0.0004),
    };
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

class ImplementerSession implements CodingAgentSession {
  readonly id: string;

  constructor(
    private readonly spec: CodingAgentSpec,
    private readonly tools: ImplementerAgentToolbox,
    private readonly recovering: boolean,
  ) {
    this.id = recovering ? "demo-implementer-session-2" : "demo-implementer-session-1";
  }

  async *run(signal: AbortSignal): AsyncIterable<CodingAgentEvent> {
    signal.throwIfAborted();
    yield started(this.id, ["bash", "edit", "read", "write"]);

    if (this.recovering) {
      yield* this.finish(signal);
      return;
    }
    yield* this.interruptedAttempt(signal);
  }

  /**
   * Worker A: make the edit, complete the turn, then wait forever.
   *
   * The turn has to complete, because a completed turn is what
   * `SessionAccounting` captures a checkpoint after - and the checkpoint is
   * what the demo goes on to kill this process for. After that this session
   * deliberately makes no further progress: the harness is watching Postgres
   * for the checkpoint and sends `SIGKILL` the moment it appears, so anything
   * this session did next would be a race with the kill rather than part of the
   * demonstration.
   */
  private async *interruptedAttempt(signal: AbortSignal): AsyncIterable<CodingAgentEvent> {
    yield { type: "turn_started", turn: 0 };

    const file = `${this.spec.workdir}/${SOURCE_FILE}`;
    const before = await this.tools.readFile(file, signal);
    if (!before.content.includes(BUG)) {
      throw new Error(
        `${SOURCE_FILE} does not contain the seeded bug (${BUG}); the fixture has changed.`,
      );
    }
    await this.tools.writeFile(file, before.content.replace(BUG, FIX), signal);

    yield {
      type: "assistant_message",
      turn: 0,
      text:
        `Changed the boundary comparison in ${SOURCE_FILE} from \`>\` to \`>=\` so an order of ` +
        "exactly BULK_THRESHOLD items qualifies. Next: run the suite.",
    };
    yield { type: "usage", turn: 0, usage: usage(3_400, 900, 0.0011) };
    yield { type: "turn_completed", turn: 0 };

    await waitForAbort(signal);
    yield { type: "session_ended", reason: "aborted", turns: 1, usage: usage(0, 0, 0) };
    signal.throwIfAborted();
  }

  /**
   * Worker B: verify what was restored, run the suite, and stop.
   *
   * No edit. If the restored patch did not arrive, this throws inside the
   * container and the job fails loudly instead of quietly re-fixing the bug and
   * making a broken restore look like a successful recovery.
   */
  private async *finish(signal: AbortSignal): AsyncIterable<CodingAgentEvent> {
    yield { type: "turn_started", turn: 0 };

    const file = `${this.spec.workdir}/${SOURCE_FILE}`;
    const restored = await this.tools.readFile(file, signal);
    if (!restored.content.includes(FIX)) {
      throw new Error(
        `The restored workspace does not contain the interrupted attempt's edit to ${SOURCE_FILE}. ` +
          "Recovery did not deliver the checkpointed work.",
      );
    }

    const diff = await this.tools.exec({
      argv: ["git", "diff", "--stat"],
      cwd: this.spec.workdir,
      timeoutMs: this.spec.commandTimeoutMs,
    });
    const tests = await this.tools.exec({
      argv: ["npm", "test"],
      cwd: this.spec.workdir,
      timeoutMs: this.spec.commandTimeoutMs,
    });
    if (tests.exitCode !== 0) {
      throw new Error(`The restored workspace still fails its own suite: ${tests.stderr.trim()}`);
    }

    yield {
      type: "assistant_message",
      turn: 0,
      text:
        "Continued the interrupted attempt rather than restarting it. The restored working tree " +
        `already contained the boundary fix in ${SOURCE_FILE} (${diff.stdout.trim() || "no stat"}), ` +
        "and `npm test` now passes, so the seeded bug is fixed and nothing else was touched.",
    };
    yield { type: "usage", turn: 0, usage: usage(2_800, 600, 0.0009) };
    yield { type: "turn_completed", turn: 0 };
    yield {
      type: "session_ended",
      reason: "completed",
      turns: 1,
      usage: usage(2_800, 600, 0.0009),
    };
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

function started(sessionId: string, toolNames: string[]): CodingAgentEvent {
  return {
    type: "session_started",
    sessionId,
    model: "scripted-recovery-demo",
    provider: "rivet",
    toolNames,
  };
}

function usage(inputTokens: number, outputTokens: number, costUsd: number) {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
