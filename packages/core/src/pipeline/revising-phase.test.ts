import type { JobDetail, ReviewReport } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import type {
  AgentToolbox,
  CodingAgent,
  CodingAgentEvent,
  CodingAgentSession,
  CodingAgentSpec,
  ImplementerAgentToolbox,
} from "../agent/coding-agent";
import type { Sandbox, SandboxProvider } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import type {
  PhaseCheckpointInput,
  PhaseContext,
  PhaseEventInput,
  PhaseExecInput,
  RecordedCommand,
} from "./phase-context";
import type { AgentOptions, PipelineOptions } from "./phases";
import { revisingPhase } from "./revising-phase";

const REVIEW: ReviewReport = {
  decision: "revise",
  blockingIssues: [
    {
      title: "Empty orders are not rejected",
      detail: "The implementation still returns zero for an empty order.",
      paths: ["src/order.ts"],
      category: "edge_case",
    },
  ],
  nonBlockingIssues: [
    {
      title: "Keep the regression test focused",
      detail: "The new test can assert the public error rather than an implementation detail.",
      paths: ["src/order.test.ts"],
      category: "weak_test",
    },
  ],
  confidence: 0.8,
  summary: "The main path is correct, but the named empty-order boundary still needs a change.",
};

const JOB = {
  id: "11111111-2222-3333-4444-555555555555",
  title: "Fix order totals",
  description: "Empty orders should be rejected.",
  repoUrl: "https://github.com/acme/widgets",
  baseBranch: "main",
  baseCommitSha: "abc1234",
  maxCostUsd: "5.00",
  maxModelCalls: 20,
  maxToolCalls: 20,
  reviewMode: "independent",
  maxReviewLoops: 2,
  reviewLoops: 1,
  reviewDecision: "revise",
  reviewBlockingCount: 1,
} as unknown as JobDetail;

const AGENT: AgentOptions = {
  coding: undefined as never,
  sessionTimeoutMs: 10_000,
  maxTurns: 5,
  previewMaxBytes: 1_024,
  fileMaxBytes: 4_096,
};

const OPTIONS: PipelineOptions = {
  sandbox: undefined as never,
  image: "node@sha256:deadbeef",
  workdir: "/home/node/workspace",
  memoryBytes: 1,
  nanoCpus: 1,
  pidsLimit: 1,
  commandTimeoutMs: 1_000,
  cloneTimeoutMs: 1_000,
  installTimeoutMs: 1_000,
  baselineTimeoutMs: 1_000,
  checkTimeoutMs: 1_000,
  diffMaxBytes: 1_024,
  validationReportMaxBytes: 2_048,
  targetedMaxFiles: 25,
};

const REPO_DIR = "/home/node/workspace/repo";

class ScriptedImplementer implements CodingAgent {
  readonly specs: CodingAgentSpec[] = [];
  readonly writes: { path: string; content: string }[] = [];
  readonly commands: string[][] = [];
  readonly sessions: ScriptedSession[] = [];

  start(
    spec: CodingAgentSpec,
    tools: AgentToolbox,
    _signal: AbortSignal,
  ): Promise<CodingAgentSession> {
    if (tools.role !== "implementer") throw new Error("expected implementer capabilities");
    this.specs.push(spec);
    const session = new ScriptedSession(tools);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

class ScriptedSession implements CodingAgentSession {
  readonly id = "revision-session";
  stopCount = 0;

  constructor(private readonly tools: ImplementerAgentToolbox) {}

  async *run(signal: AbortSignal): AsyncIterable<CodingAgentEvent> {
    signal.throwIfAborted();
    await this.tools.readFile(`${REPO_DIR}/src/order.ts`, signal);
    await this.tools.writeFile(`${REPO_DIR}/src/order.ts`, "fixed\n", signal);
    await this.tools.exec({
      argv: ["bash", "-lc", "pnpm test"],
      cwd: REPO_DIR,
      timeoutMs: 1_000,
    });

    yield {
      type: "session_started",
      sessionId: this.id,
      model: "fake",
      provider: "fake",
      toolNames: ["bash", "edit", "read", "write"],
    };
    yield { type: "turn_started", turn: 0 };
    yield {
      type: "usage",
      turn: 0,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    };
    yield { type: "turn_completed", turn: 0 };
    yield {
      type: "session_ended",
      reason: "completed",
      turns: 1,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    };
  }

  stop(): Promise<void> {
    this.stopCount += 1;
    return Promise.resolve();
  }
}

function command(input: PhaseExecInput, stdout: string): RecordedCommand {
  return {
    ...input,
    exitCode: 0,
    stdout,
    stderr: "",
    truncated: false,
    timedOut: false,
    oomKilled: false,
    durationMs: 1,
    commandId: 1,
    commandExecutionId: "command-1",
  };
}

function harness(review: ReviewReport | null = REVIEW) {
  const holder = new SandboxHolder();
  const controller = new AbortController();
  const events: PhaseEventInput[] = [];
  const checkpoints: PhaseCheckpointInput[] = [];
  const commands: string[][] = [];
  const writes: { path: string; content: string }[] = [];
  const reads: string[] = [];
  const agent = new ScriptedImplementer();

  const sandbox: Sandbox = {
    id: "sandbox-1",
    exec: () => Promise.reject(new Error("the phase must go through ctx.exec")),
    getFile: (path) => {
      reads.push(path);
      return Promise.resolve({ content: "export function orderTotal() {}\n", truncated: false });
    },
    putFile: (path, content) => {
      writes.push({ path, content });
      return Promise.resolve();
    },
    destroy: () => Promise.resolve(),
  };
  holder.set(sandbox);

  const provider: SandboxProvider = {
    create: () => Promise.reject(new Error("not used")),
    reap: () => Promise.resolve([]),
  };

  const context: PhaseContext = {
    job: JOB,
    phase: { status: "revising", label: "Revise change", durationMs: 0, recovery: "checkpoint" },
    sandboxes: holder,
    signal: controller.signal,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    exec: (input) => {
      commands.push(input.argv);
      const stdout =
        input.argv[0] === "ls"
          ? ".\n..\nREADME.md\npackage.json\nsrc\n"
          : input.argv[0] === "git"
            ? "package.json\nsrc/order.ts\nsrc/order.test.ts\n"
            : input.argv[0] === "head"
              ? "# widgets\n"
              : JSON.stringify({ name: "widgets", scripts: { test: "pnpm test" } });
      return Promise.resolve(command(input, stdout));
    },
    event: (input) => {
      events.push(input);
      return Promise.resolve();
    },
    artifact: () => Promise.reject(new Error("revising records no artifacts")),
    readBaseline: () => Promise.resolve("passed"),
    readBaselineReport: () => Promise.resolve(null),
    readSummary: () => Promise.resolve(null),
    readValidation: () => Promise.resolve(null),
    readValidationReport: () => Promise.resolve(null),
    readLatestReviewReport: () => Promise.resolve(review),
    recordProvisioning: () => Promise.resolve(),
    recordAgentUsage: () => Promise.resolve(),
    readLatestCheckpoint: () => Promise.resolve(null),
    captureWorkspace: () => Promise.reject(new Error("revising asks for a checkpoint")),
    checkpoint: (input) => {
      checkpoints.push(input);
      return Promise.resolve({ id: checkpoints.length } as never);
    },
  };

  const options: PipelineOptions = { ...OPTIONS, sandbox: provider };
  const agentOptions: AgentOptions = { ...AGENT, coding: agent };

  return {
    run: () => revisingPhase(agentOptions, options)(context),
    agent,
    context,
    events,
    checkpoints,
    commands,
    reads,
    writes,
    controller,
  };
}

describe("revisingPhase", () => {
  it("reuses the implementer session and gives it both finding lists", async () => {
    const test = harness();

    await test.run();

    expect(test.agent.specs[0]?.role).toBe("implementer");
    expect(test.agent.specs[0]?.context).toContain("Empty orders are not rejected");
    expect(test.agent.specs[0]?.context).toContain("The implementation still returns zero");
    expect(test.agent.specs[0]?.context).toContain("Keep the regression test focused");
    expect(test.agent.specs[0]?.context).toContain("do not re-litigate its design");
    expect(test.commands).toContainEqual(["bash", "-lc", "pnpm test"]);
    expect(test.reads).toContain(`${REPO_DIR}/src/order.ts`);
    expect(test.writes).toEqual([{ path: `${REPO_DIR}/src/order.ts`, content: "fixed\n" }]);
    expect(test.agent.sessions[0]?.stopCount).toBe(1);
  });

  it("checkpoints a revision turn with revising as its resume phase", async () => {
    const test = harness();

    await test.run();

    expect(test.checkpoints).toMatchObject([
      {
        kind: "agent_turn",
        agentTurn: 1,
        resumePhase: "revising",
        repositoryDir: REPO_DIR,
      },
    ]);
  });

  it("refuses to revise without the durable blocking review report", async () => {
    const test = harness(null);

    await expect(test.run()).rejects.toThrow(/could not find the review report/);
    expect(test.agent.specs).toEqual([]);
  });
});
