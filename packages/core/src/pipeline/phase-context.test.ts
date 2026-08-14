import type { JobArtifact, JobCommand, JobDetail, JobEvent } from "@rivet/contracts";
import type { Database } from "@rivet/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordArtifactInput } from "../artifacts/artifact-store";
import { recordArtifact } from "../artifacts/artifact-store";
import {
  recordCheckpoint,
  type JobCheckpoint,
  type RecordCheckpointInput,
} from "../checkpoints/checkpoint-store";
import type { AppendEventInput } from "../events/event-service";
import { appendEvent } from "../events/event-service";
import { recordCommand } from "../sandbox/command-log";
import type { ExecResult, Sandbox } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import { createPhaseContextFactory, type PhaseExecInput, type PhaseLogger } from "./phase-context";

vi.mock("../events/event-service", () => ({ appendEvent: vi.fn() }));
vi.mock("../sandbox/command-log", () => ({ recordCommand: vi.fn() }));
vi.mock("../artifacts/artifact-store", () => ({ recordArtifact: vi.fn() }));
vi.mock("../checkpoints/checkpoint-store", () => ({ recordCheckpoint: vi.fn() }));

const JOB = {
  id: "11111111-2222-3333-4444-555555555555",
  attemptCount: 2,
  baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
  envFingerprint: { image: "node@sha256:test" },
} as unknown as JobDetail;

const PHASE = {
  status: "provisioning",
  label: "Provision sandbox",
  durationMs: 0,
} as const;

const INPUT: PhaseExecInput = {
  argv: ["git", "clone", "https://example.com/repo.git"],
  cwd: "/home/node/workspace",
  timeoutMs: 10_000,
};

const RESULT: ExecResult = {
  argv: INPUT.argv,
  cwd: INPUT.cwd,
  exitCode: 0,
  stdout: "cloned\n",
  stderr: "",
  truncated: false,
  timedOut: false,
  oomKilled: false,
  durationMs: 12,
};

function fakeDatabase() {
  const transaction = vi.fn((callback: (tx: unknown) => Promise<unknown>) =>
    Promise.resolve(callback({})),
  );
  return { database: { transaction } as unknown as Database, transaction };
}

function harness(exec: () => Promise<ExecResult> = () => Promise.resolve(RESULT)) {
  const holder = new SandboxHolder();
  const events: AppendEventInput[] = [];
  const artifacts: RecordArtifactInput[] = [];
  const checkpoints: RecordCheckpointInput[] = [];
  const sequence: string[] = [];
  const sandboxExec = vi.fn(() => {
    sequence.push("exec");
    return exec();
  });
  const sandbox: Sandbox = {
    id: "sandbox-1",
    exec: sandboxExec,
    getFile: () => Promise.reject(new Error("the context does not read files")),
    putFile: () => Promise.reject(new Error("the context does not write files")),
    destroy: () => Promise.resolve(),
  };
  holder.set(sandbox);

  const { database, transaction } = fakeDatabase();
  const warn = vi.fn<PhaseLogger["warn"]>();

  vi.mocked(appendEvent).mockImplementation((input) => {
    events.push(input);
    sequence.push(`event:${input.type}`);
    return Promise.resolve({} as JobEvent);
  });
  vi.mocked(recordCommand).mockImplementation(() => {
    sequence.push("record");
    return Promise.resolve({ id: 17 } as JobCommand);
  });
  vi.mocked(recordArtifact).mockImplementation((input) => {
    artifacts.push(input);
    sequence.push("artifact");
    return Promise.resolve({
      id: 42,
      type: input.type,
      byteSize: Buffer.byteLength(input.content, "utf8"),
      truncated: Buffer.byteLength(input.content, "utf8") > input.maxBytes,
    } as JobArtifact);
  });
  vi.mocked(recordCheckpoint).mockImplementation((input) => {
    checkpoints.push(input);
    sequence.push("checkpoint");
    return Promise.resolve({ id: 43 } as JobCheckpoint);
  });

  const context = createPhaseContextFactory({
    job: JOB,
    leaseOwner: "worker-1",
    sandboxes: holder,
    signal: new AbortController().signal,
    log: { debug: vi.fn(), info: vi.fn(), warn },
    maxOutputBytes: 1_024,
    artifactMaxBytes: 2_048,
    checkpointMaxBytes: 4_096,
    checkpointTimeoutMs: 30_000,
    database,
  })(PHASE);

  return {
    context,
    events,
    artifacts,
    checkpoints,
    sequence,
    sandboxExec,
    transaction,
    warn,
  };
}

describe("PhaseContext command lifecycle", () => {
  beforeEach(() => {
    vi.mocked(appendEvent).mockReset();
    vi.mocked(recordCommand).mockReset();
    vi.mocked(recordCheckpoint).mockReset();
  });

  it("records a start before execution and pairs completion with the same id", async () => {
    const test = harness();

    const result = await test.context.exec(INPUT);

    expect(test.sequence).toEqual([
      "event:command.started",
      "exec",
      "record",
      "event:command.completed",
    ]);
    expect(test.sandboxExec).toHaveBeenCalledOnce();
    // One transaction fences the start event; the second owns the command row
    // and its completion event.
    expect(test.transaction).toHaveBeenCalledTimes(2);
    expect(result.commandId).toBe(17);

    const started = test.events[0];
    const completed = test.events[1];
    expect(typeof started?.data?.commandExecutionId).toBe("string");
    expect(started?.data).toMatchObject({
      argv: INPUT.argv,
      cwd: INPUT.cwd,
      phase: PHASE.label,
    });
    expect(completed?.data).toMatchObject({
      commandExecutionId: started?.data?.commandExecutionId,
      commandId: 17,
      argv: RESULT.argv,
      exitCode: RESULT.exitCode,
      durationMs: RESULT.durationMs,
    });
  });

  it("records a failed command and rethrows the sandbox error", async () => {
    const cause = new Error("sandbox socket closed");
    const test = harness(() => Promise.reject(cause));

    await expect(test.context.exec(INPUT)).rejects.toBe(cause);

    expect(test.sequence).toEqual(["event:command.started", "exec", "event:command.failed"]);
    expect(test.transaction).toHaveBeenCalledTimes(2);
    expect(test.events[1]?.data).toMatchObject({
      commandExecutionId: test.events[0]?.data?.commandExecutionId,
      argv: INPUT.argv,
      cwd: INPUT.cwd,
      phase: PHASE.label,
      error: cause.message,
    });
  });

  it("does not mask the sandbox error when the failed event cannot be written", async () => {
    const cause = new Error("container disappeared");
    const eventWriteError = new Error("database unavailable");
    const test = harness(() => Promise.reject(cause));
    vi.mocked(appendEvent).mockImplementation((input) => {
      test.events.push(input);
      test.sequence.push(`event:${input.type}`);
      if (input.type === "command.failed") return Promise.reject(eventWriteError);
      return Promise.resolve({} as JobEvent);
    });

    await expect(test.context.exec(INPUT)).rejects.toBe(cause);

    const warning = test.warn.mock.calls[0];
    expect(warning?.[0].err).toBe(eventWriteError);
    expect(typeof warning?.[0].commandExecutionId).toBe("string");
    expect(warning?.[1]).toBe("could not record command failure event");
  });

  it("does not execute a command when its start event cannot be written", async () => {
    const eventWriteError = new Error("database unavailable");
    const test = harness();
    vi.mocked(appendEvent).mockRejectedValue(eventWriteError);

    await expect(test.context.exec(INPUT)).rejects.toBe(eventWriteError);

    expect(test.sandboxExec).not.toHaveBeenCalled();
    expect(test.transaction).toHaveBeenCalledOnce();
  });
});

describe("PhaseContext checkpoints", () => {
  it("supplies job and sandbox identity to the lease-fenced store", async () => {
    const test = harness();

    await test.context.checkpoint({
      kind: "agent_turn",
      state: { version: 1 },
      patch: Buffer.from("patch"),
      agentTurn: 4,
    });

    expect(test.checkpoints[0]).toMatchObject({
      jobId: JOB.id,
      attemptCount: 2,
      kind: "agent_turn",
      baseCommitSha: JOB.baseCommitSha,
      sandboxId: "sandbox-1",
      envFingerprint: JOB.envFingerprint,
      maxBytes: 4_096,
      leaseOwner: "worker-1",
      agentTurn: 4,
    });
    expect(test.checkpoints[0]?.patch).toEqual(Buffer.from("patch"));
    expect(test.checkpoints[0]?.state).toEqual({ version: 1 });
    expect(vi.mocked(recordCheckpoint)).toHaveBeenCalledOnce();
  });
});

describe("PhaseContext artifacts", () => {
  beforeEach(() => {
    vi.mocked(appendEvent).mockReset();
    vi.mocked(recordCommand).mockReset();
    vi.mocked(recordArtifact).mockReset();
    vi.mocked(recordCheckpoint).mockReset();
  });

  it("writes the row and the event that points at it in one transaction", async () => {
    const test = harness();

    const artifactId = await test.context.artifact({ type: "diff", content: "diff --git\n" });

    expect(artifactId).toBe(42);
    expect(test.sequence).toEqual(["artifact", "event:artifact.recorded"]);
    expect(test.transaction).toHaveBeenCalledOnce();
    expect(test.events[0]?.type).toBe("artifact.recorded");
    expect(test.events[0]?.data).toMatchObject({
      artifactId: 42,
      artifactType: "diff",
      byteSize: 11,
      truncated: false,
      phase: PHASE.label,
    });
  });

  it("stamps the phase's status on the row and hands the writer the configured bound", async () => {
    const test = harness();

    await test.context.artifact({
      type: "diff_stat",
      content: "1\t0\tsrc/a.js\n",
      metadata: { filesChanged: 1 },
    });

    expect(test.artifacts[0]).toMatchObject({
      jobId: JOB.id,
      type: "diff_stat",
      phase: PHASE.status,
      maxBytes: 2_048,
      metadata: { filesChanged: 1 },
    });
  });

  it("passes complete-artifact requests through to the bounded writer", async () => {
    const test = harness();

    await test.context.artifact({
      type: "implementation_plan",
      content: '{"problemInterpretation":"ok"}',
      requireComplete: true,
    });

    expect(test.artifacts[0]?.requireComplete).toBe(true);
  });

  it("keeps the content out of the event, which is read in full on every render", async () => {
    const test = harness();

    await test.context.artifact({ type: "diff", content: "x".repeat(4_096) });

    expect(JSON.stringify(test.events[0])).not.toContain("xxxx");
    expect(test.events[0]?.data).toMatchObject({ byteSize: 4_096, truncated: true });
  });

  it("lets a phase say what happened in its own words", async () => {
    const test = harness();

    await test.context.artifact({
      type: "implementation_summary",
      content: "Fixed the comparison.",
      message: "Session summary recorded",
    });

    expect(test.events[0]?.message).toBe("Session summary recorded");
  });

  it("states the type and the true size when the phase says nothing", async () => {
    const test = harness();

    await test.context.artifact({ type: "implementation_summary", content: "ok" });

    expect(test.events[0]?.message).toBe("Recorded implementation summary (2 bytes)");
  });
});
