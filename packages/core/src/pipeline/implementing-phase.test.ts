import type { JobDetail } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { AgentSessionTimedOutError } from "../agent/errors";
import type {
  AgentToolbox,
  CodingAgent,
  CodingAgentEvent,
  CodingAgentSession,
  CodingAgentSpec,
} from "../agent/coding-agent";
import type { BaselineOutcome } from "../events/baseline-log";
import { BudgetExceededError, JobCancelledError } from "../jobs/failure";
import type { ExecResult, Sandbox, SandboxProvider } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import { implementingPhase } from "./implementing-phase";
import type {
  PhaseContext,
  PhaseEventInput,
  PhaseExecInput,
  RecordedCommand,
} from "./phase-context";
import type { AgentOptions, PipelineOptions } from "./phases";

/**
 * The phase against a scripted agent: no database, no Docker, no model.
 *
 * The fake here is deliberately local rather than imported from
 * `@rivet/agent`. Core must not depend on its own adapters even in a test - the
 * dependency arrow points one way, and a devDependency that reverses it would
 * be the first crack in the reason this package exists.
 *
 * What is actually being asserted: the phase records what the session did, adds
 * up what it cost, stops the session on every exit including the bad ones, and
 * enforces the ceilings itself rather than trusting a harness to.
 */

const JOB = {
  id: "11111111-2222-3333-4444-555555555555",
  title: "Fix the off-by-one in sum()",
  description: "`sum(1, 2)` returns 2.",
  repoUrl: "https://github.com/acme/widgets",
  baseBranch: "main",
  baseCommitSha: "abc1234",
  maxCostUsd: "5.00",
  maxModelCalls: 200,
  maxToolCalls: 500,
} as unknown as JobDetail;

const OPTIONS_BASE = {
  image: "node@sha256:deadbeef",
  workdir: "/home/node/workspace",
  memoryBytes: 2_147_483_648,
  nanoCpus: 2_000_000_000,
  pidsLimit: 512,
  commandTimeoutMs: 120_000,
  cloneTimeoutMs: 180_000,
  installTimeoutMs: 300_000,
  baselineTimeoutMs: 300_000,
  diffMaxBytes: 1_048_576,
};

const AGENT_BASE = {
  sessionTimeoutMs: 900_000,
  maxTurns: 40,
  previewMaxBytes: 2_048,
  fileMaxBytes: 262_144,
};

const DEFAULT_LISTING = ".\n..\n.git\nREADME.md\npackage.json\npnpm-lock.yaml\nsrc\n";
const DEFAULT_TRACKED = "package.json\nsrc/sum.ts\nsrc/sum.test.ts\n";
const DEFAULT_README = "# widgets\n\nA library of widgets.\n";
const DEFAULT_MANIFEST = JSON.stringify({
  name: "widgets",
  dependencies: { left_pad: "^1.0.0" },
  scripts: { test: "vitest run", lint: "eslint .", build: "tsc" },
});

/** A session that yields a fixed list, or misbehaves on request. */
class ScriptedAgent implements CodingAgent {
  readonly sessions: ScriptedSession[] = [];
  specs: CodingAgentSpec[] = [];

  constructor(
    private readonly script: {
      events?: CodingAgentEvent[];
      throws?: Error;
      hang?: boolean;
      useTools?: (tools: AgentToolbox, signal: AbortSignal) => Promise<void>;
    } = {},
  ) {}

  start(
    spec: CodingAgentSpec,
    tools: AgentToolbox,
    _signal: AbortSignal,
  ): Promise<CodingAgentSession> {
    this.specs.push(spec);
    const session = new ScriptedSession(this.script, tools);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

class ScriptedSession implements CodingAgentSession {
  readonly id = "session-1";
  stopCount = 0;

  constructor(
    private readonly script: {
      events?: CodingAgentEvent[];
      throws?: Error;
      hang?: boolean;
      useTools?: (tools: AgentToolbox, signal: AbortSignal) => Promise<void>;
    },
    private readonly tools: AgentToolbox,
  ) {}

  async *run(signal: AbortSignal): AsyncIterable<CodingAgentEvent> {
    if (this.script.useTools) await this.script.useTools(this.tools, signal);
    for (const event of this.script.events ?? []) {
      signal.throwIfAborted();
      yield event;
    }
    if (this.script.hang) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
    }
    if (this.script.throws) throw this.script.throws;
  }

  stop(): Promise<void> {
    this.stopCount += 1;
    return Promise.resolve();
  }
}

type Responder = (argv: string[]) => Partial<ExecResult> | undefined;

function harness(
  options: {
    agent?: ScriptedAgent;
    overrides?: Partial<AgentOptions>;
    job?: Partial<JobDetail>;
    respond?: Responder;
    /** What `analyzing` recorded, or an error to prove the builder survives one. */
    baseline?: BaselineOutcome | null | Error;
  } = {},
) {
  const holder = new SandboxHolder();
  const controller = new AbortController();
  const executed: PhaseExecInput[] = [];
  const events: PhaseEventInput[] = [];
  const infos: Record<string, unknown>[] = [];
  const warnings: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const usages: Record<string, unknown>[] = [];

  const sandbox: Sandbox = {
    id: "c0ffee0c0ffee",
    exec: () => Promise.reject(new Error("the phase must go through ctx.exec")),
    getFile: (path) => {
      reads.push(path);
      return Promise.resolve({ content: "export const sum = () => 0;\n", truncated: false });
    },
    putFile: (path, content) => {
      writes.push({ path, content });
      return Promise.resolve();
    },
    destroy: () => Promise.resolve(),
  };
  holder.set(sandbox);

  const provider: SandboxProvider = {
    create: () => Promise.reject(new Error("this phase never creates a sandbox")),
    reap: () => Promise.resolve([]),
  };

  const agent = options.agent ?? new ScriptedAgent();
  const agentOptions: AgentOptions = { ...AGENT_BASE, ...options.overrides, coding: agent };
  const pipelineOptions: PipelineOptions = {
    ...OPTIONS_BASE,
    sandbox: provider,
    agent: agentOptions,
  };

  const ctx: PhaseContext = {
    job: { ...JOB, ...options.job },
    phase: { status: "implementing", label: "Implement change", durationMs: 0 },
    sandboxes: holder,
    signal: controller.signal,
    log: {
      debug: () => undefined,
      info: (details) => infos.push(details),
      warn: (details) => warnings.push(details),
    },

    exec: (input) => {
      executed.push(input);
      const scripted = options.respond?.(input.argv) ?? defaultResponse(input.argv);
      return Promise.resolve({
        argv: input.argv,
        cwd: input.cwd,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        oomKilled: false,
        durationMs: 5,
        commandId: executed.length,
        commandExecutionId: `exec-${executed.length}`,
        ...scripted,
      } satisfies RecordedCommand);
    },

    event: (input) => {
      events.push(input);
      return Promise.resolve();
    },

    artifact: () => Promise.reject(new Error("the implementing phase records no artifacts")),

    readBaseline: () =>
      options.baseline instanceof Error
        ? Promise.reject(options.baseline)
        : Promise.resolve(options.baseline ?? null),

    recordProvisioning: () => Promise.resolve(),
    recordAgentUsage: (patch) => {
      usages.push(patch);
      return Promise.resolve();
    },
  };

  return {
    run: () => implementingPhase(agentOptions, pipelineOptions)(ctx),
    agent,
    controller,
    executed,
    events,
    infos,
    warnings,
    reads,
    writes,
    usages,
    typesOf: () => events.map((event) => event.type),
    find: (type: string) => events.find((event) => event.type === type),
  };
}

function defaultResponse(argv: string[]): Partial<ExecResult> | undefined {
  if (argv[0] === "ls") return { stdout: DEFAULT_LISTING };
  if (argv[0] === "git") return { stdout: DEFAULT_TRACKED };
  if (argv[0] === "head") return { stdout: DEFAULT_README };
  if (argv[0] === "cat") return { stdout: DEFAULT_MANIFEST };
  return undefined;
}

const USAGE = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.25,
};

/** One ordinary session: a turn, a message, a tool call, a cost, an ending. */
const HAPPY_PATH: CodingAgentEvent[] = [
  {
    type: "session_started",
    sessionId: "session-1",
    model: "deepseek/deepseek-v4-flash",
    provider: "openrouter",
    toolNames: ["bash", "edit", "read", "write"],
  },
  { type: "turn_started", turn: 0 },
  { type: "assistant_message", turn: 0, text: "Reading sum.ts." },
  {
    type: "tool_started",
    turn: 0,
    toolCallId: "call-1",
    toolName: "bash",
    argsPreview: '{"command":"pnpm test"}',
    commandExecutionId: "exec-7",
  },
  {
    type: "tool_completed",
    turn: 0,
    toolCallId: "call-1",
    toolName: "bash",
    isError: false,
    durationMs: 900,
    resultPreview: "1 failed",
    commandExecutionId: "exec-7",
  },
  { type: "usage", turn: 0, usage: USAGE },
  { type: "turn_completed", turn: 0 },
  { type: "session_ended", reason: "completed", turns: 1, usage: USAGE },
];

describe("implementingPhase", () => {
  it("puts the session on the timeline, in order", async () => {
    const test = harness({ agent: new ScriptedAgent({ events: HAPPY_PATH }) });

    await test.run();

    expect(test.typesOf()).toEqual([
      "agent.session_started",
      "agent.turn_started",
      "agent.message",
      "agent.tool_started",
      "agent.tool_completed",
      "agent.usage",
      "agent.session_ended",
    ]);
  });

  it("stamps every row with the session id, so two sessions stay separable", async () => {
    const test = harness({ agent: new ScriptedAgent({ events: HAPPY_PATH }) });

    await test.run();

    const agentEvents = test.events.filter((event) => event.type.startsWith("agent."));
    expect(agentEvents.every((event) => event.data?.sessionId === "session-1")).toBe(true);
  });

  it("writes no row for a completed turn, because the next one says so", async () => {
    const test = harness({ agent: new ScriptedAgent({ events: HAPPY_PATH }) });

    await test.run();

    expect(test.typesOf()).not.toContain("agent.turn_completed");
  });

  it("points a shell tool call at the command transcript it produced", async () => {
    const test = harness({ agent: new ScriptedAgent({ events: HAPPY_PATH }) });

    await test.run();

    expect(test.find("agent.tool_started")?.data?.commandExecutionId).toBe("exec-7");
    expect(test.find("agent.tool_completed")?.data?.commandExecutionId).toBe("exec-7");
  });

  it("adds up usage across turns and reports the running total", async () => {
    const test = harness({
      agent: new ScriptedAgent({
        events: [
          { type: "usage", turn: 0, usage: USAGE },
          { type: "usage", turn: 1, usage: USAGE },
          { type: "session_ended", reason: "completed", turns: 2, usage: USAGE },
        ],
      }),
    });

    await test.run();

    const ended = test.find("agent.session_ended");
    expect(ended?.data?.inputTokens).toBe(2_000);
    expect(ended?.data?.outputTokens).toBe(400);
    expect(ended?.data?.costUsd).toBeCloseTo(0.5);
    expect(test.usages).toEqual([
      { totalInputTokens: 1_000, totalOutputTokens: 200, totalCostUsd: "0.2500" },
      { totalInputTokens: 2_000, totalOutputTokens: 400, totalCostUsd: "0.5000" },
    ]);
  });

  it("stops the session on the happy path", async () => {
    const test = harness({ agent: new ScriptedAgent({ events: HAPPY_PATH }) });

    await test.run();

    expect(test.agent.sessions[0]?.stopCount).toBe(1);
  });

  it("stops the session when the run throws", async () => {
    const test = harness({ agent: new ScriptedAgent({ throws: new Error("provider is down") }) });

    await expect(test.run()).rejects.toThrow("provider is down");
    expect(test.agent.sessions[0]?.stopCount).toBe(1);
  });

  it("stops the session when the job is cancelled mid-run", async () => {
    const test = harness({ agent: new ScriptedAgent({ hang: true }) });

    const running = test.run();
    // After the session exists, not before: aborting during the context build
    // would prove only that the phase checks its signal, which is a different
    // and much less interesting claim.
    await settle();
    test.controller.abort(new JobCancelledError("cancel requested"));

    await expect(running).rejects.toThrow(JobCancelledError);
    expect(test.agent.sessions[0]?.stopCount).toBe(1);
  });

  it("gives the agent a toolbox that reaches the sandbox and nothing else", async () => {
    const test = harness({
      agent: new ScriptedAgent({
        useTools: async (tools, signal) => {
          await tools.readFile("/home/node/workspace/repo/src/sum.ts", signal);
          await tools.writeFile("/home/node/workspace/repo/src/sum.ts", "fixed\n", signal);
          await tools.exec({
            argv: ["bash", "-lc", "pnpm test"],
            cwd: "/home/node/workspace/repo",
            timeoutMs: 1_000,
          });
        },
      }),
    });

    await test.run();

    expect(test.reads).toEqual(["/home/node/workspace/repo/src/sum.ts"]);
    expect(test.writes[0]?.content).toBe("fixed\n");
    // Through `ctx.exec`, which is what makes it a `job_commands` row like any
    // other command Rivet ran.
    expect(test.executed.at(-1)?.argv).toEqual(["bash", "-lc", "pnpm test"]);
  });

  it("tells the model where it is, what the project is, and what is tracked", async () => {
    const agent = new ScriptedAgent();
    const test = harness({ agent });

    await test.run();

    const context = agent.specs[0]?.context ?? "";
    expect(context).toContain("/home/node/workspace/repo");
    expect(context).toContain("corepack pnpm run test");
    expect(context).toContain("src/sum.ts");
  });

  it("passes the job's own ceilings into the session spec", async () => {
    const agent = new ScriptedAgent();
    const test = harness({
      agent,
      job: { maxToolCalls: 12, maxModelCalls: 9, maxCostUsd: "2.50" },
    });

    await test.run();

    expect(agent.specs[0]?.limits).toEqual({
      maxTurns: 40,
      maxToolCalls: 12,
      maxModelCalls: 9,
      maxCostUsd: 2.5,
    });
  });

  it("reads an unusable cost ceiling as absent rather than as zero", async () => {
    const agent = new ScriptedAgent();
    const test = harness({ agent, job: { maxCostUsd: "" } });

    await test.run();

    expect(agent.specs[0]?.limits.maxCostUsd).toBeNull();
  });

  it("starts persisted totals from the job row on a reclaimed attempt", async () => {
    const test = harness({
      job: { totalInputTokens: 900, totalOutputTokens: 100, totalCostUsd: "1.1250" },
      agent: new ScriptedAgent({
        events: [{ type: "usage", turn: 0, usage: USAGE }],
      }),
    });

    await test.run();

    expect(test.usages).toEqual([
      { totalInputTokens: 1_900, totalOutputTokens: 300, totalCostUsd: "1.3750" },
    ]);
  });
});

/**
 * The sentence Stage 4 exists to replace, in each of its four readings.
 *
 * Four rather than three because "nobody has looked yet" is a different fact
 * from "we looked and there was nothing to run", and a model told the wrong one
 * goes hunting for a test script that either is or is not there.
 */
describe("the baseline the model is told about", () => {
  const contextFor = async (baseline: BaselineOutcome | null | Error) => {
    const agent = new ScriptedAgent();
    await harness({ agent, baseline }).run();
    return agent.specs[0]?.context ?? "";
  };

  it("says a red suite is the task and not the model's fault", async () => {
    const context = await contextFor("failed");

    expect(context).toContain("FAILED");
    expect(context).toContain("not your fault");
    // The exact command the baseline ran, so "re-run it" is unambiguous.
    expect(context).toContain("corepack pnpm run test");
    expect(context).not.toContain("has not been run");
  });

  it("says a green suite has to stay green", async () => {
    const context = await contextFor("passed");

    expect(context).toContain("PASSED");
    expect(context).toContain("must still pass");
  });

  it("distinguishes a skipped baseline from an absent one", async () => {
    expect(await contextFor("skipped")).toContain("No baseline could be established");
    expect(await contextFor(null)).toContain("has not been run");
  });

  it("still builds a context when the baseline cannot be read", async () => {
    const agent = new ScriptedAgent();
    const test = harness({ agent, baseline: new Error("database unavailable") });

    await test.run();

    expect(agent.specs[0]?.context).toContain("has not been run");
    expect(test.warnings.some((warning) => warning.err instanceof Error)).toBe(true);
  });
});

describe("what else the first prompt carries", () => {
  it("includes the README head and the manifest's scripts", async () => {
    const agent = new ScriptedAgent();
    const test = harness({ agent });

    await test.run();

    const context = agent.specs[0]?.context ?? "";
    expect(context).toContain("A library of widgets.");
    expect(context).toContain('"lint": "eslint ."');
    // Only the scripts block. The dependency list is a lockfile in prose.
    expect(context).not.toContain("left_pad");
  });

  it("bounds the README in the container rather than after the fact", async () => {
    const test = harness({});

    await test.run();

    const head = test.executed.find((input) => input.argv[0] === "head");
    expect(head?.argv).toEqual(["head", "-c", "4096", "README.md"]);
    expect(head?.maxOutputBytes).toBe(4_096);
  });

  it("reads no README when the repository has none", async () => {
    const agent = new ScriptedAgent();
    const test = harness({
      agent,
      respond: (argv) =>
        argv[0] === "ls" ? { stdout: ".\n..\npackage.json\npnpm-lock.yaml\n" } : undefined,
    });

    await test.run();

    expect(test.executed.some((input) => input.argv[0] === "head")).toBe(false);
    expect(agent.specs[0]?.context).not.toContain("README.md (first");
  });

  it("survives a manifest that is not readable as JSON", async () => {
    const agent = new ScriptedAgent();
    const test = harness({
      agent,
      respond: (argv) => (argv[0] === "cat" ? { stdout: "{" } : undefined),
    });

    await test.run();

    expect(agent.specs[0]?.context).not.toContain("package.json scripts");
  });

  it("asks for a verified change and a closing summary", async () => {
    const agent = new ScriptedAgent();
    const test = harness({ agent });

    await test.run();

    const context = agent.specs[0]?.context ?? "";
    expect(context).toContain("Run the test suite yourself");
    expect(context).toContain("End your last turn with a plain message");
    // Milestone 9 owns git identity; nothing here should be committing.
    expect(context).toContain("do not create branches");
  });
});

describe("the implementation summary", () => {
  const summaryLog = (test: ReturnType<typeof harness>) =>
    test.infos.find((entry) => "hasSummary" in entry);

  it("retains the last non-empty assistant message", async () => {
    const test = harness({
      agent: new ScriptedAgent({
        events: [
          { type: "assistant_message", turn: 0, text: "Reading sum.ts." },
          { type: "assistant_message", turn: 1, text: "Fixed the comparison in sum()." },
          { type: "session_ended", reason: "completed", turns: 2, usage: USAGE },
        ],
      }),
    });

    await test.run();

    expect(summaryLog(test)).toMatchObject({
      hasSummary: true,
      summaryBytes: Buffer.byteLength("Fixed the comparison in sum().", "utf8"),
    });
  });

  it("does not let a whitespace message replace a real one", async () => {
    const test = harness({
      agent: new ScriptedAgent({
        events: [
          { type: "assistant_message", turn: 0, text: "Fixed the comparison." },
          { type: "assistant_message", turn: 1, text: "  \n" },
          { type: "session_ended", reason: "completed", turns: 2, usage: USAGE },
        ],
      }),
    });

    await test.run();

    expect(summaryLog(test)?.summaryBytes).toBe(21);
  });

  it("reports an absent summary rather than inventing one", async () => {
    const test = harness({
      agent: new ScriptedAgent({
        events: [{ type: "session_ended", reason: "completed", turns: 1, usage: USAGE }],
      }),
    });

    await test.run();

    expect(summaryLog(test)).toMatchObject({ hasSummary: false, summaryBytes: 0 });
  });
});

describe("budgets", () => {
  const turns = (count: number): CodingAgentEvent[] =>
    Array.from({ length: count }, (_unused, index) => ({
      type: "turn_started" as const,
      turn: index,
    }));

  it("stops on the turn ceiling", async () => {
    const test = harness({
      agent: new ScriptedAgent({ events: turns(5) }),
      overrides: { maxTurns: 3 },
    });

    await expect(test.run()).rejects.toThrow(BudgetExceededError);
    expect(test.find("agent.budget_exceeded")?.data).toMatchObject({
      budget: "turns",
      budgetValue: 4,
      budgetLimit: 3,
    });
  });

  it("stops on the model-call ceiling", async () => {
    const test = harness({
      agent: new ScriptedAgent({ events: turns(5) }),
      job: { maxModelCalls: 2 },
    });

    await expect(test.run()).rejects.toThrow(/model call ceiling/);
  });

  it("stops on the tool-call ceiling", async () => {
    const call = (index: number): CodingAgentEvent => ({
      type: "tool_started",
      turn: 0,
      toolCallId: `call-${index}`,
      toolName: "read",
      argsPreview: "{}",
    });
    const test = harness({
      agent: new ScriptedAgent({ events: [call(1), call(2), call(3)] }),
      job: { maxToolCalls: 2 },
    });

    await expect(test.run()).rejects.toThrow(/tool call ceiling/);
  });

  it("stops on the cost ceiling", async () => {
    const test = harness({
      agent: new ScriptedAgent({
        events: [
          { type: "usage", turn: 0, usage: { ...USAGE, costUsd: 0.9 } },
          { type: "usage", turn: 1, usage: { ...USAGE, costUsd: 0.9 } },
        ],
      }),
      job: { maxCostUsd: "1.00" },
    });

    await expect(test.run()).rejects.toThrow(/spend ceiling/);
  });

  it("stops the session even when a ceiling ends the run", async () => {
    const test = harness({
      agent: new ScriptedAgent({ events: turns(5) }),
      overrides: { maxTurns: 1 },
    });

    await expect(test.run()).rejects.toThrow(BudgetExceededError);
    expect(test.agent.sessions[0]?.stopCount).toBe(1);
  });

  it("says out loud when a cost ceiling cannot be enforced, rather than passing silently", async () => {
    const test = harness({
      agent: new ScriptedAgent({
        events: [
          { type: "usage", turn: 0, usage: { ...USAGE, costUsd: null } },
          { type: "usage", turn: 1, usage: { ...USAGE, costUsd: null } },
          { type: "session_ended", reason: "completed", turns: 2, usage: USAGE },
        ],
      }),
      job: { maxCostUsd: "1.00" },
    });

    await test.run();

    // Once, not once per turn.
    expect(test.warnings.filter((warning) => "maxCostUsd" in warning)).toHaveLength(1);
    expect(test.find("agent.usage")?.message).toContain("no rate table");
    expect(test.find("agent.session_ended")?.data?.costUsd).toBeNull();
  });
});

describe("deadlines", () => {
  it("fails with the session's own deadline, not the job's", async () => {
    const test = harness({
      agent: new ScriptedAgent({ hang: true }),
      overrides: { sessionTimeoutMs: 20 },
    });

    await expect(test.run()).rejects.toThrow(AgentSessionTimedOutError);
  });

  it("prefers the job's reason when both deadlines are in play", async () => {
    const test = harness({
      agent: new ScriptedAgent({ hang: true }),
      overrides: { sessionTimeoutMs: 20 },
    });

    const running = test.run();
    await settle();
    test.controller.abort(new JobCancelledError("cancel requested"));

    await expect(running).rejects.toThrow(JobCancelledError);
  });
});

/** Lets the phase get as far as starting a session before a test interferes. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}
