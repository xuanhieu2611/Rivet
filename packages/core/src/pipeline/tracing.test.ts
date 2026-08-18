import type { JobArtifact, JobCommand, JobDetail, JobEvent } from "@rivet/contracts";
import type { Database } from "@rivet/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentToolbox,
  CodingAgent,
  CodingAgentEvent,
  CodingAgentSession,
  CodingAgentSpec,
} from "../agent/coding-agent";
import { recordArtifact } from "../artifacts/artifact-store";
import { recordAgentUsage } from "../jobs/agent-usage";
import { appendEvent, type AppendEventInput } from "../events/event-service";
import { recordCommand } from "../sandbox/command-log";
import type { ExecResult, Sandbox } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import {
  ATTR_AGENT_TOOL,
  ATTR_AGENT_TURN,
  ATTR_ATTEMPT,
  ATTR_COMMAND,
  ATTR_JOB_ID,
  ATTR_PHASE,
  SPAN_AGENT_SESSION,
  SPAN_AGENT_TOOL,
  SPAN_AGENT_TURN,
  SPAN_JOB_RUN,
  SPAN_SANDBOX_COMMAND,
} from "../telemetry/attributes";
import { RecordingTelemetry, type RecordedSpan } from "../telemetry/recording-telemetry";
import { runAgentSession } from "./agent-session";
import { createPhaseContextFactory } from "./phase-context";
import type { Phase, AgentOptions } from "./phases";
import { runPipeline } from "./run-pipeline";

vi.mock("../events/event-service", () => ({ appendEvent: vi.fn() }));
vi.mock("../sandbox/command-log", () => ({ recordCommand: vi.fn() }));
vi.mock("../artifacts/artifact-store", () => ({
  recordArtifact: vi.fn(),
  readLatestArtifactContent: vi.fn(),
  readLatestImplementationPlan: vi.fn(),
}));
vi.mock("../checkpoints/checkpoint-store", () => ({
  recordCheckpoint: vi.fn(),
  getLatestCheckpoint: vi.fn(),
}));
vi.mock("../jobs/agent-usage", () => ({ recordAgentUsage: vi.fn() }));

/**
 * **Acceptance run A - one job, one trace, one shape.**
 *
 * `docs/plans/milestone-11.md`: "A job run through the pipeline against a
 * recording telemetry fake produces a span tree whose phase spans match the
 * job's `phase.completed` events exactly, in order, with model and command
 * spans nested under the phase that ran them and every span carrying
 * `rivet.job_id`. Asserted in-process, with no collector."
 *
 * That is what this file is, and the reason it can be an ordinary unit test -
 * no SDK, no exporter, no Docker, no database - is the whole argument for
 * telemetry being a port. The run below uses the **real** `runPipeline`, the
 * **real** `createPhaseContextFactory` and the **real** `runAgentSession`; only
 * the four durable writers, the sandbox and the coding agent are fakes, exactly
 * as they are in every other pipeline test here.
 *
 * The one thing this cannot assert is the processor's `job.run` root, which
 * lives in `apps/worker`. It is stood in for below by opening the same span
 * with the same link the processor opens it with, so the shape under test is
 * the shape production produces.
 */

const JOB = {
  id: "11111111-2222-3333-4444-555555555555",
  attemptCount: 2,
  title: "Add a health check",
  description: "Return 200 at /api/health.",
  baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
  envFingerprint: {},
  traceContext: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  totalCostUsd: "0",
} as unknown as JobDetail;

const RESULT: ExecResult = {
  argv: ["pnpm", "test"],
  cwd: "/workspace/repo",
  exitCode: 0,
  stdout: "",
  stderr: "",
  truncated: false,
  timedOut: false,
  oomKilled: false,
  durationMs: 12,
};

/** Two phases with bodies, which is enough for "in order" to mean something. */
function phases(agent: AgentOptions): Phase[] {
  return [
    {
      status: "analyzing",
      label: "Establish test baseline",
      durationMs: 0,
      recovery: "replay",
      run: async (ctx) => {
        await ctx.exec({ argv: ["pnpm", "install"], cwd: "/workspace/repo", timeoutMs: 1_000 });
        await ctx.exec({ argv: ["pnpm", "test"], cwd: "/workspace/repo", timeoutMs: 1_000 });
        return undefined;
      },
    },
    // A planner rather than an implementer, and only so that the session does
    // not capture a turn checkpoint: this file is about span shape, and a real
    // workspace capture would need a real Git working tree in a container. The
    // session lifecycle - and therefore every span it opens - is identical for
    // both roles.
    {
      status: "planning",
      label: "Create plan",
      durationMs: 0,
      recovery: "replay",
      run: async (ctx) => {
        await runAgentSession(agent, spec(), toolbox(), ctx);
        return undefined;
      },
    },
  ];
}

function spec(): CodingAgentSpec {
  return {
    role: "planner",
    workdir: "/workspace/repo",
    task: { title: JOB.title, description: JOB.description },
    context: "",
    sessionTimeoutMs: 60_000,
    commandTimeoutMs: 1_000,
    previewMaxBytes: 1_024,
    limits: { maxTurns: 8, maxToolCalls: 8, maxModelCalls: 8, maxCostUsd: null },
  };
}

function toolbox(): AgentToolbox {
  return {
    exec: () => Promise.reject(new Error("unused")),
    readFile: () => Promise.reject(new Error("unused")),
    writeFile: () => Promise.reject(new Error("unused")),
  } as unknown as AgentToolbox;
}

/**
 * One turn with one tool call, which is the smallest session that can prove
 * nesting: a tool span under a turn span under a session span under a phase.
 */
const SESSION_EVENTS: CodingAgentEvent[] = [
  {
    type: "session_started",
    sessionId: "s-1",
    model: "test-model",
    provider: "test",
    toolNames: ["bash"],
  },
  { type: "turn_started", turn: 1 },
  { type: "tool_started", turn: 1, toolName: "bash", toolCallId: "t-1", argsPreview: "ls" },
  {
    type: "tool_completed",
    turn: 1,
    toolName: "bash",
    toolCallId: "t-1",
    resultPreview: "ok",
    isError: false,
    durationMs: 3,
  },
  { type: "turn_completed", turn: 1 },
  { type: "session_ended", reason: "completed", turns: 1 },
] as CodingAgentEvent[];

function agentOptions(): AgentOptions {
  const session: CodingAgentSession = {
    id: "s-1",
    // The port is an async iterable, so this fake has to be one even though it
    // has nothing to await.
    // eslint-disable-next-line @typescript-eslint/require-await
    run: async function* () {
      for (const event of SESSION_EVENTS) yield event;
    },
    stop: () => Promise.resolve(),
  };
  const coding: CodingAgent = { start: () => Promise.resolve(session) };
  return {
    coding,
    sessionTimeoutMs: 60_000,
    maxTurns: 8,
    previewMaxBytes: 1_024,
    fileMaxBytes: 1_024,
  };
}

interface RunResult {
  telemetry: RecordingTelemetry;
  events: AppendEventInput[];
  root: RecordedSpan;
}

async function run(): Promise<RunResult> {
  const events: AppendEventInput[] = [];
  vi.mocked(appendEvent).mockImplementation((input) => {
    events.push(input);
    return Promise.resolve({} as JobEvent);
  });
  vi.mocked(recordCommand).mockResolvedValue({ id: 1 } as JobCommand);
  // Returns "the lease is still held", which is all the context asks of it.
  vi.mocked(recordAgentUsage).mockResolvedValue(true);
  vi.mocked(recordArtifact).mockResolvedValue({
    id: 1,
    type: "diff",
    byteSize: 0,
    truncated: false,
  } as JobArtifact);

  const sandbox: Sandbox = {
    id: "sandbox-1",
    exec: (request) => Promise.resolve({ ...RESULT, argv: request.argv, cwd: request.cwd }),
    getFile: () => Promise.reject(new Error("unused")),
    putFile: () => Promise.reject(new Error("unused")),
    putArchive: () => Promise.reject(new Error("unused")),
    destroy: () => Promise.resolve(),
  };
  const holder = new SandboxHolder();
  holder.set(sandbox);

  const database = {
    transaction: (callback: (tx: unknown) => Promise<unknown>) => Promise.resolve(callback({})),
  } as unknown as Database;

  const telemetry = new RecordingTelemetry();
  const agent = agentOptions();

  // The processor's root, reproduced exactly: a *link* to the creating
  // request's stored `traceparent` rather than a parent, because the two are
  // deliberately different traces.
  const root = telemetry.startSpan(SPAN_JOB_RUN, {
    kind: "consumer",
    links: [{ traceContext: JOB.traceContext! }],
    attributes: { [ATTR_JOB_ID]: JOB.id, [ATTR_ATTEMPT]: JOB.attemptCount },
  }) as RecordedSpan;

  const context = createPhaseContextFactory({
    job: JOB,
    leaseOwner: "worker-1",
    sandboxes: holder,
    signal: new AbortController().signal,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    maxOutputBytes: 1_024,
    artifactMaxBytes: 2_048,
    checkpointMaxBytes: 4_096,
    checkpointTimeoutMs: 30_000,
    database,
    telemetry,
  });

  await runPipeline({
    phases: phases(agent),
    signal: new AbortController().signal,
    speed: 0,
    sleep: () => Promise.resolve(),
    context,
    telemetry,
    rootSpan: root,
    spanAttributes: { jobId: JOB.id, attempt: JOB.attemptCount },
    onPhaseStart: (phase) =>
      Promise.resolve(
        void events.push({ jobId: JOB.id, type: "phase.started", message: phase.label }),
      ),
    onPhaseComplete: (phase) =>
      Promise.resolve(
        void events.push({ jobId: JOB.id, type: "phase.completed", message: phase.label }),
      ),
  });
  root.end();

  return { telemetry, events, root };
}

/** The nearest enclosing phase span, which is what "ran them" means. */
function enclosingPhase(span: RecordedSpan): RecordedSpan | undefined {
  for (let at = span.parent; at; at = at.parent) {
    if (at.name.startsWith("phase.")) return at;
  }
  return undefined;
}

describe("acceptance run A - one job, one trace, one shape", () => {
  beforeEach(() => {
    vi.mocked(appendEvent).mockReset();
    vi.mocked(recordCommand).mockReset();
    vi.mocked(recordArtifact).mockReset();
    vi.mocked(recordAgentUsage).mockReset();
  });

  it("opens exactly one phase span per phase.completed event, in the same order", async () => {
    const { telemetry, events } = await run();

    const completed = events
      .filter((event) => event.type === "phase.completed")
      .map((event) => event.message);
    const phaseSpans = telemetry.spans.filter((span) => span.name.startsWith("phase."));

    expect(phaseSpans.map((span) => span.name)).toEqual(["phase.analyzing", "phase.planning"]);
    expect(completed).toEqual(["Establish test baseline", "Create plan"]);
    expect(phaseSpans).toHaveLength(completed.length);
  });

  it("nests command spans under the phase that ran them", async () => {
    const { telemetry } = await run();

    const commands = telemetry.spansNamed(SPAN_SANDBOX_COMMAND);
    expect(commands).toHaveLength(2);
    expect(commands.map((span) => span.attributes[ATTR_COMMAND])).toEqual(["pnpm", "pnpm"]);
    for (const span of commands) {
      expect(enclosingPhase(span)?.name).toBe("phase.analyzing");
      expect(span.attributes[ATTR_PHASE]).toBe("analyzing");
    }
  });

  it("nests the model session, its turns and its tool calls under the planning phase", async () => {
    const { telemetry } = await run();

    const session = telemetry.spansNamed(SPAN_AGENT_SESSION);
    const turns = telemetry.spansNamed(SPAN_AGENT_TURN);
    const tools = telemetry.spansNamed(SPAN_AGENT_TOOL);

    expect(session).toHaveLength(1);
    expect(turns).toHaveLength(1);
    expect(tools).toHaveLength(1);

    expect(session[0]?.parent?.name).toBe("phase.planning");
    expect(turns[0]?.parent).toBe(session[0]);
    expect(tools[0]?.parent).toBe(turns[0]);
    expect(turns[0]?.attributes[ATTR_AGENT_TURN]).toBe(1);
    expect(tools[0]?.attributes[ATTR_AGENT_TOOL]).toBe("bash");
    expect(enclosingPhase(tools[0]!)?.name).toBe("phase.planning");
  });

  it("puts rivet.job_id on every span, which is what makes one filter answer for a job", async () => {
    const { telemetry } = await run();

    for (const span of telemetry.spans) {
      expect(span.attributes[ATTR_JOB_ID], `${span.name} carries no job id`).toBe(JOB.id);
    }
  });

  it("makes the attempt its own trace, linked to the creating request rather than parented by it", async () => {
    const { telemetry, root } = await run();

    expect(telemetry.rootSpans()).toEqual([root]);
    expect(root.parent).toBeUndefined();
    expect(root.links).toEqual([{ traceContext: JOB.traceContext }]);
    // One trace, and it is not the request's.
    expect(new Set(telemetry.spans.map((span) => span.traceId))).toEqual(new Set([root.traceId]));
    expect(root.traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("leaves no span open, which is the instrumentation bug that produces no error", async () => {
    const { telemetry } = await run();

    expect(telemetry.openSpans()).toEqual([]);
  });
});
