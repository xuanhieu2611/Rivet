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
import { appendEvent, type AppendEventInput } from "../events/event-service";
import { recordAgentUsage } from "../jobs/agent-usage";
import { type RecordCommandInput, recordCommand } from "../sandbox/command-log";
import type { ExecResult, Sandbox } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import { ATTR_ATTEMPT, ATTR_JOB_ID, SPAN_JOB_RUN } from "../telemetry/attributes";
import { RecordingTelemetry } from "../telemetry/recording-telemetry";
import type { Telemetry } from "../telemetry/telemetry";
import { runAgentSession } from "./agent-session";
import { createPhaseContextFactory } from "./phase-context";
import type { AgentOptions, Phase } from "./phases";
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
 * **Acceptance run C - telemetry is not in the way.**
 *
 * `docs/plans/milestone-11.md`: "The same job run with `RIVET_TELEMETRY=off`
 * and with the adapter attached produces byte-identical projected event lists
 * and identical terminal state."
 *
 * The technique is M10's: run the thing twice, project both runs down to what a
 * reader would actually see, and compare the projections rather than trusting
 * that the difference is confined to where it was meant to be. There it proved
 * an evaluation job indistinguishable from an ordinary one; here it proves an
 * observed job indistinguishable from an unobserved one.
 *
 * "Byte-identical" is meant literally, so the comparison is over serialized
 * JSON rather than over `toEqual`. `toEqual` treats a missing key and an
 * explicit `undefined` as the same value, and a telemetry path that started
 * stamping `{ traceId: undefined }` onto every event payload is exactly the
 * regression this run exists to catch.
 *
 * The two runs share one harness and differ in exactly one argument, because
 * two harnesses that drift apart would agree with each other about nothing in
 * particular. The `off` run passes no `telemetry` at all, which is what
 * `RIVET_TELEMETRY=off` produces: `PipelineOptions.telemetry` is absent and
 * every use site reads `?? NOOP_TELEMETRY`.
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
  stdout: "baseline ok",
  stderr: "",
  truncated: false,
  timedOut: false,
  oomKilled: false,
  durationMs: 12,
};

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

/** What a reader of the job sees: the durable rows, in the order they were written. */
interface Projection {
  events: AppendEventInput[];
  commands: RecordCommandInput[];
  artifacts: unknown[];
  phases: string[];
  outcome: string;
}

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
        await ctx.artifact({ type: "diff", content: "diff --git a/a b/a\n" });
        return undefined;
      },
    },
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

function agentOptions(): AgentOptions {
  const session: CodingAgentSession = {
    id: "s-1",
    // eslint-disable-next-line @typescript-eslint/require-await -- the port is an async iterable
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

/**
 * One run of the pipeline, with telemetry or without it.
 *
 * Everything that could make two runs differ for a reason other than telemetry
 * is pinned: the same job, the same fake sandbox returning the same bytes, the
 * same session transcript, and a `durationMs` scrubbed out of the projection
 * below because a wall clock is not a fact about the job.
 */
async function project(telemetry: Telemetry | undefined): Promise<Projection> {
  const events: AppendEventInput[] = [];
  const commands: RecordCommandInput[] = [];
  const artifacts: unknown[] = [];

  vi.mocked(appendEvent).mockImplementation((input) => {
    events.push(input);
    return Promise.resolve({} as JobEvent);
  });
  vi.mocked(recordCommand).mockImplementation((input) => {
    commands.push(input);
    return Promise.resolve({ id: commands.length } as JobCommand);
  });
  vi.mocked(recordArtifact).mockImplementation((input) => {
    artifacts.push(input);
    return Promise.resolve({
      id: artifacts.length,
      type: "diff",
      byteSize: 0,
      truncated: false,
    } as JobArtifact);
  });
  vi.mocked(recordAgentUsage).mockResolvedValue(true);

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

  const completed: string[] = [];
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
    ...(telemetry ? { telemetry } : {}),
  });

  // The processor's root, opened only when there is telemetry to open it on -
  // which is exactly the difference between the two production paths.
  const rootSpan = telemetry?.startSpan(SPAN_JOB_RUN, {
    kind: "consumer",
    links: [{ traceContext: JOB.traceContext! }],
    attributes: { [ATTR_JOB_ID]: JOB.id, [ATTR_ATTEMPT]: JOB.attemptCount },
  });

  let outcome = "completed";
  try {
    await runPipeline({
      phases: phases(agentOptions()),
      signal: new AbortController().signal,
      speed: 0,
      sleep: () => Promise.resolve(),
      context,
      ...(telemetry ? { telemetry } : {}),
      ...(rootSpan ? { rootSpan } : {}),
      spanAttributes: { jobId: JOB.id, attempt: JOB.attemptCount },
      onPhaseStart: (phase) =>
        Promise.resolve(
          void events.push({ jobId: JOB.id, type: "phase.started", message: phase.label }),
        ),
      onPhaseComplete: (phase) => {
        completed.push(phase.status);
        events.push({ jobId: JOB.id, type: "phase.completed", message: phase.label });
        return Promise.resolve();
      },
    });
  } catch (error) {
    outcome = `failed:${error instanceof Error ? error.message : String(error)}`;
  }
  rootSpan?.end();

  return { events, commands, artifacts, phases: completed, outcome };
}

/**
 * Wall clocks out, correlation kept, everything else in.
 *
 * Two things differ between any two runs of anything for reasons that are not
 * telemetry: a duration, and `commandExecutionId`, which is a fresh UUID per
 * execution. A duration is replaced outright because it carries no structure.
 * An execution id is replaced with the ordinal of its first appearance rather
 * than dropped, so the thing it exists for - a `command.started` and a
 * `command.completed` naming the *same* execution - is still part of what the
 * two runs have to agree about.
 */
function scrub(value: unknown): unknown {
  const ordinals = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(value, (key, inner: unknown) => {
      if (key === "durationMs" || key === "startedAt" || key === "endedAt") return "<scrubbed>";
      if (key === "commandExecutionId" && typeof inner === "string") {
        const seen = ordinals.get(inner);
        if (seen) return seen;
        const ordinal = `<execution-${ordinals.size + 1}>`;
        ordinals.set(inner, ordinal);
        return ordinal;
      }
      return inner;
    }),
  ) as unknown;
}

describe("acceptance run C - telemetry is not in the way", () => {
  beforeEach(() => {
    vi.mocked(appendEvent).mockReset();
    vi.mocked(recordCommand).mockReset();
    vi.mocked(recordArtifact).mockReset();
    vi.mocked(recordAgentUsage).mockReset();
  });

  it("writes byte-identical durable rows with the adapter attached and with it off", async () => {
    const off = await project(undefined);
    const on = await project(new RecordingTelemetry());

    // The positive control. Two runs that both produced nothing would compare
    // equal and prove nothing at all, so the projection has to be non-trivial
    // before its equality is worth anything.
    expect(off.events.length).toBeGreaterThan(4);
    expect(off.commands).toHaveLength(2);
    expect(off.artifacts).toHaveLength(1);

    expect(JSON.stringify(scrub(on.events))).toBe(JSON.stringify(scrub(off.events)));
    expect(JSON.stringify(scrub(on.commands))).toBe(JSON.stringify(scrub(off.commands)));
    expect(JSON.stringify(scrub(on.artifacts))).toBe(JSON.stringify(scrub(off.artifacts)));
  });

  it("reaches the same terminal state through the same phases", async () => {
    const off = await project(undefined);
    const on = await project(new RecordingTelemetry());

    expect(off.outcome).toBe("completed");
    expect(on.outcome).toBe(off.outcome);
    expect(on.phases).toEqual(off.phases);
    expect(on.phases).toEqual(["analyzing", "planning"]);
  });

  it("still opened the spans, so the comparison was against a real observed run", async () => {
    // Without this the run above is satisfiable by a telemetry object that does
    // nothing, which is the same shape of hole the positive controls close
    // everywhere else in this milestone.
    const telemetry = new RecordingTelemetry();
    await project(telemetry);

    expect(telemetry.spans.length).toBeGreaterThan(4);
    expect(telemetry.spans.some((span) => span.name.startsWith("phase."))).toBe(true);
  });
});
