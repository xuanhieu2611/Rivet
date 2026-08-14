import type { ImplementationPlan, JobDetail, JobEventType } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import type {
  AgentToolbox,
  CodingAgent,
  CodingAgentEvent,
  CodingAgentSession,
  CodingAgentSpec,
  PlannerAgentToolbox,
} from "../agent/coding-agent";
import { PlanNotProducedError } from "../agent/errors";
import type { Sandbox, SandboxProvider } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import { planningPhase } from "./planning-phase";
import type {
  PhaseArtifactInput,
  PhaseContext,
  PhaseEventInput,
  RecordedCommand,
} from "./phase-context";
import type { AgentOptions, PipelineOptions } from "./phases";

const PLAN: ImplementationPlan = {
  problemInterpretation: "sum returns one less than the expected total.",
  relevantComponents: ["src/index.ts", "src/index.test.ts"],
  reproductionStrategy: ["Run pnpm test and reproduce the failing sum assertion."],
  implementationApproach: ["Correct the implementation without changing the test."],
  validationPlan: ["Run pnpm test after the change."],
  riskAreas: ["Other arithmetic helpers may share the same implementation."],
};

const JOB = {
  id: "11111111-2222-3333-4444-555555555555",
  title: "Fix the off-by-one",
  description: "sum(1, 2) returns 2.",
  repoUrl: "https://github.com/acme/widgets",
  baseBranch: "main",
  baseCommitSha: "abc1234",
  maxCostUsd: "5.00",
  maxModelCalls: 20,
  maxToolCalls: 20,
} as unknown as JobDetail;

const NO_USAGE = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

const REPO_DIR = "/home/node/workspace/repo";

function command(argv: string[], stdout: string): RecordedCommand {
  return {
    argv,
    cwd: REPO_DIR,
    exitCode: 0,
    stdout,
    stderr: "",
    truncated: false,
    timedOut: false,
    oomKilled: false,
    durationMs: 1,
    commandId: 1,
    commandExecutionId: `command-${argv.join("-")}`,
  };
}

class ScriptedPlanner implements CodingAgent {
  readonly specs: CodingAgentSpec[] = [];
  stopCount = 0;

  constructor(private readonly submit: boolean) {}

  start(
    spec: CodingAgentSpec,
    tools: AgentToolbox,
    _signal: AbortSignal,
  ): Promise<CodingAgentSession> {
    this.specs.push(spec);
    if (tools.role !== "planner") throw new Error("expected planner capabilities");
    const plannerTools: PlannerAgentToolbox = tools;
    const submit = this.submit;

    return Promise.resolve({
      id: "planner-session-1",
      async *run(signal: AbortSignal): AsyncIterable<CodingAgentEvent> {
        signal.throwIfAborted();
        if (submit) {
          await plannerTools.listFiles(signal);
          await plannerTools.readFile(`${REPO_DIR}/src/index.ts`, signal);
          await plannerTools.searchText("sum", signal);
          await plannerTools.submitPlan(PLAN, signal);
        } else {
          yield { type: "assistant_message", turn: 0, text: JSON.stringify(PLAN) };
        }
        yield {
          type: "session_started",
          sessionId: "planner-session-1",
          model: "fake",
          provider: "fake",
          toolNames: ["list_files", "read", "search_text", "submit_plan"],
        };
        yield { type: "turn_started", turn: 0 };
        yield { type: "usage", turn: 0, usage: NO_USAGE };
        yield { type: "turn_completed", turn: 0 };
        yield { type: "session_ended", reason: "completed", turns: 1, usage: NO_USAGE };
      },
      stop: () => {
        this.stopCount += 1;
        return Promise.resolve();
      },
    });
  }
}

function harness(planner: ScriptedPlanner) {
  const controller = new AbortController();
  const holder = new SandboxHolder();
  const events: PhaseEventInput[] = [];
  const artifacts: PhaseArtifactInput[] = [];
  const commands: string[][] = [];
  const usages: unknown[] = [];

  const sandbox: Sandbox = {
    id: "sandbox-1",
    exec: () => Promise.reject(new Error("planning uses the phase context")),
    getFile: (path) => {
      if (path.endsWith("src/index.ts")) {
        return Promise.resolve({
          content: "export const sum = (a, b) => a + b - 1;\n",
          truncated: false,
        });
      }
      return Promise.reject(new Error(`unexpected read: ${path}`));
    },
    putFile: () => Promise.reject(new Error("planner cannot write")),
    destroy: () => Promise.resolve(),
  };
  holder.set(sandbox);

  const context: PhaseContext = {
    job: JOB,
    phase: { status: "planning", label: "Create plan", durationMs: 0 },
    sandboxes: holder,
    signal: controller.signal,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    exec: (input) => {
      commands.push(input.argv);
      const stdout =
        input.argv[0] === "ls"
          ? ".\n..\nREADME.md\npackage.json\nsrc\n"
          : input.argv[1] === "ls-files"
            ? "package.json\nsrc/index.ts\nsrc/index.test.ts\n"
            : input.argv[0] === "head"
              ? "# widgets\n"
              : JSON.stringify({
                  name: "widgets",
                  packageManager: "pnpm@10",
                  scripts: { test: "pnpm test" },
                });
      return Promise.resolve(command(input.argv, stdout));
    },
    event: (input) => {
      events.push(input);
      return Promise.resolve();
    },
    artifact: (input) => {
      artifacts.push(input);
      return Promise.resolve(42);
    },
    readBaseline: () => Promise.resolve("failed"),
    readSummary: () => Promise.resolve(null),
    readValidation: () => Promise.resolve(null),
    recordProvisioning: () => Promise.resolve(),
    recordAgentUsage: (usage) => {
      usages.push(usage);
      return Promise.resolve();
    },
    readLatestCheckpoint: () => Promise.resolve(null),
    captureWorkspace: () => Promise.reject(new Error("no workspace capture here")),
    checkpoint: () => Promise.reject(new Error("planning does not checkpoint")),
  };

  const provider: SandboxProvider = {
    create: () => Promise.reject(new Error("not used")),
    reap: () => Promise.resolve([]),
  };
  const options: PipelineOptions = {
    sandbox: provider,
    image: "node@sha256:deadbeef",
    workdir: "/home/node/workspace",
    memoryBytes: 1,
    nanoCpus: 1,
    pidsLimit: 1,
    commandTimeoutMs: 1_000,
    cloneTimeoutMs: 1_000,
    installTimeoutMs: 1_000,
    baselineTimeoutMs: 1_000,
    diffMaxBytes: 1_024,
  };
  const agent: AgentOptions = {
    coding: planner,
    sessionTimeoutMs: 10_000,
    maxTurns: 5,
    previewMaxBytes: 1_024,
    fileMaxBytes: 4_096,
  };

  return { agent, context, options, artifacts, commands, controller, events, usages };
}

describe("planningPhase", () => {
  it("uses read-only progressive tools and persists only a submitted plan", async () => {
    const planner = new ScriptedPlanner(true);
    const test = harness(planner);

    await planningPhase(test.agent, test.options)(test.context);

    expect(planner.specs[0]?.role).toBe("planner");
    expect(test.commands).toEqual([
      ["ls", "-1", "-a", REPO_DIR],
      ["git", "ls-files"],
      ["head", "-c", "4096", "README.md"],
      ["cat", "package.json"],
      ["git", "ls-files"],
      ["git", "grep", "-n", "--no-color", "-e", "sum", "--", "."],
    ]);
    expect(test.artifacts).toEqual([
      expect.objectContaining({ type: "implementation_plan", requireComplete: true }),
    ]);
    expect(JSON.parse(test.artifacts[0]!.content)).toEqual(PLAN);
    expect(test.events.at(-1)).toEqual({
      type: "plan.recorded" satisfies JobEventType,
      message: "Implementation plan recorded.",
      data: { artifactId: 42, artifactType: "implementation_plan", agentRole: "planner" },
    });
    expect(test.usages).toEqual([
      { totalInputTokens: 1, totalOutputTokens: 2, totalCostUsd: "0.0000", totalTurns: 0 },
      { totalInputTokens: 1, totalOutputTokens: 2, totalCostUsd: "0.0000", totalTurns: 1 },
    ]);
    expect(planner.stopCount).toBe(1);
  });

  it("fails when the session never calls submit_plan", async () => {
    const planner = new ScriptedPlanner(false);
    const test = harness(planner);

    await expect(planningPhase(test.agent, test.options)(test.context)).rejects.toBeInstanceOf(
      PlanNotProducedError,
    );
    expect(test.artifacts).toEqual([]);
    expect(test.events.some((event) => event.type === "plan.recorded")).toBe(false);
  });

  it("honors cancellation before starting the planner", async () => {
    const planner = new ScriptedPlanner(true);
    const test = harness(planner);
    test.controller.abort(new Error("cancelled"));

    await expect(planningPhase(test.agent, test.options)(test.context)).rejects.toThrow(
      "cancelled",
    );
    expect(planner.specs).toEqual([]);
  });
});
