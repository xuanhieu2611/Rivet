import type { CodingAgentEvent } from "@rivet/core";
import {
  AgentFailedError,
  AgentUnavailableError,
  buildPipeline,
  getArtifact,
  listArtifacts,
  listCommands,
  requestJobCancellation,
  requestJobRun,
  type AgentOptions,
  type PipelineOptions,
} from "@rivet/core";
import {
  approvingReview,
  FakeCodingAgent,
  revisingReview,
  type ScriptedSession,
} from "@rivet/agent";
import { FakeSandboxProvider, type ScriptedCommand } from "@rivet/sandbox";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeConnections,
  createTestJob,
  createTestQueue,
  eventTypes,
  patchTestJob,
  readEvents,
  readJob,
  resetDatabase,
  startTestWorker,
  TEST_CONFIG,
  type TestQueue,
  type TestWorker,
  waitFor,
  waitForStatus,
} from "./support";

/**
 * The worker-level proof that a real pipeline can carry a scripted coding
 * session without a model, Docker, or a second lifecycle implementation.
 *
 * These tests keep Postgres, Redis, BullMQ, the production processor and the
 * production phase context real. Only the two external adapters are scripted:
 * the fake sandbox gives provisioning a tiny repository to work with, and the
 * fake agent supplies deterministic session events. The live smoke command is
 * the separate proof that Pi and OpenRouter work together.
 */

const REPO_DIR = "/home/node/workspace/repo";
const COMMIT = "9f2b0c1a4d5e6f708192a3b4c5d6e7f809112233";
const LISTING = ".\n..\n.git\npackage.json\npackage-lock.json\nREADME.md\ntest.js\n";
const TRACKED = "package.json\npackage-lock.json\nREADME.md\ntest.js\n";
const MANIFEST = JSON.stringify({ name: "rivet-agent-fixture", scripts: { test: "node test.js" } });

/** What the fixture's `testing` phase finds staged, so a run has something to validate. */
const DIFF = [
  "diff --git a/test.js b/test.js",
  "--- a/test.js",
  "+++ b/test.js",
  "@@ -1 +1 @@",
  "-const ok = false;",
  "+const ok = true;",
  "",
].join("\n");
const NUMSTAT = "1\t1\ttest.js\n";
/** A workspace capture validates this as an object id; see `review-fixture.ts`. */
const TREE = "3f5a1b9c7d2e40516273849506a7b8c9d0e1f2a3";

const PIPELINE_OPTIONS: Omit<PipelineOptions, "sandbox" | "agent"> = {
  image: "node@sha256:test",
  workdir: "/home/node/workspace",
  memoryBytes: 512 * 1_024 * 1_024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 128,
  commandTimeoutMs: 500,
  cloneTimeoutMs: 500,
  installTimeoutMs: 500,
  baselineTimeoutMs: 500,
  checkTimeoutMs: 500,
  diffMaxBytes: 65_536,
  validationReportMaxBytes: 262_144,
  targetedMaxFiles: 25,
};

const AGENT_OPTIONS: Omit<AgentOptions, "coding"> = {
  sessionTimeoutMs: 5_000,
  maxTurns: 8,
  previewMaxBytes: 512,
  fileMaxBytes: 4_096,
};

const USAGE = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.25,
} as const;

let queue: TestQueue;
let worker: TestWorker | undefined;

beforeAll(() => {
  queue = createTestQueue("agent", { backoff: { type: "fixed", delay: 20 } });
});

afterAll(async () => {
  await queue.destroy();
  await closeConnections();
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

/** `first` is consulted ahead of the fixture's own answers, which is how a test varies one. */
function fixtureProvider(first: ScriptedCommand[] = []): FakeSandboxProvider {
  const script: ScriptedCommand[] = [
    ...first,
    {
      match: (argv) => argv[0] === "git" && argv[1] === "rev-parse",
      stdout: `${COMMIT}\n`,
    },
    {
      match: (argv) => argv[0] === "git" && argv[1] === "ls-files",
      stdout: TRACKED,
    },
    {
      match: (argv) => argv[0] === "git" && argv[1] === "write-tree",
      stdout: `${TREE}\n`,
    },
    { match: "ls", stdout: LISTING },
    { match: "cat", stdout: MANIFEST },
    { match: "sha256sum", stdout: "abc123  package-lock.json\n" },
    {
      match: (argv) => argv[0] === "npm" && argv[1] === "--version",
      stdout: "10.0.0\n",
    },
    {
      match: (argv) => argv[0] === "npm" && argv[1] === "run",
      stdout: "fixture tests passed\n",
    },
    // Validation's three commands. Without a diff to find, every scripted
    // session here would end in `no_changes_produced` - which is the correct
    // answer for a session that changed nothing and the wrong one for a fake
    // whose edits never touched a real filesystem.
    {
      match: (argv) => argv[0] === "git" && argv[1] === "diff" && argv.includes("--numstat"),
      stdout: NUMSTAT,
    },
    { match: (argv) => argv[0] === "git" && argv[1] === "diff", stdout: DIFF },
  ];

  return new FakeSandboxProvider({
    script,
    files: { [`${REPO_DIR}/README.md`]: "The agent fixture.\n" },
  });
}

function agentPipeline(
  sandbox: FakeSandboxProvider,
  coding: FakeCodingAgent,
): ReturnType<typeof buildPipeline> {
  return buildPipeline({
    ...PIPELINE_OPTIONS,
    sandbox,
    agent: { ...AGENT_OPTIONS, coding },
  });
}

function successfulSession(sessionId = "fake-session-1"): ScriptedSession {
  const events: CodingAgentEvent[] = [
    {
      type: "session_started",
      sessionId,
      model: "fixture-model",
      provider: "fixture-provider",
      toolNames: ["bash", "edit", "read", "write"],
    },
    { type: "turn_started", turn: 0 },
    { type: "assistant_message", turn: 0, text: "I found the fixture." },
    { type: "usage", turn: 0, usage: USAGE },
    { type: "turn_completed", turn: 0 },
    { type: "session_ended", reason: "completed", turns: 1, usage: USAGE },
  ];

  return {
    events,
    useTools: async (tools, signal) => {
      const command = await tools.exec({
        argv: ["bash", "-lc", "printf agent-shell"],
        cwd: REPO_DIR,
        timeoutMs: 500,
      });
      events.splice(
        3,
        0,
        {
          type: "tool_started",
          turn: 0,
          toolCallId: "fixture-call-1",
          toolName: "bash",
          argsPreview: '{"command":"printf agent-shell"}',
          commandExecutionId: command.commandExecutionId,
        },
        {
          type: "tool_completed",
          turn: 0,
          toolCallId: "fixture-call-1",
          toolName: "bash",
          isError: false,
          durationMs: command.durationMs,
          resultPreview: "agent-shell",
          commandExecutionId: command.commandExecutionId,
        },
      );
      signal.throwIfAborted();
    },
  };
}

function sessionStarted(): CodingAgentEvent {
  return {
    type: "session_started",
    sessionId: "fake-session-1",
    model: "fixture-model",
    provider: "fixture-provider",
    toolNames: ["bash", "edit", "read", "write"],
  };
}

describe("coding-agent execution through the worker", () => {
  it("completes with ordered agent events and a command transcript", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({ script: [successfulSession()] });
    const job = await createTestJob();
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    const completed = await waitForStatus(job.id, "completed");
    const events = await readEvents(job.id);
    const agentEvents = events.filter((event) => event.type.startsWith("agent."));
    const commands = await listCommands(job.id);

    expect(agentEvents.map((event) => event.type)).toEqual([
      "agent.session_started",
      "agent.turn_started",
      "agent.message",
      "agent.tool_started",
      "agent.tool_completed",
      "agent.usage",
      "agent.turn_completed",
      "agent.session_ended",
    ]);
    expect(completed.totalInputTokens).toBe(1_000);
    expect(completed.totalOutputTokens).toBe(200);
    expect(completed.totalCostUsd).toBe("0.2500");
    expect(completed.totalTurns).toBe(1);

    const shellCommand = commands.find(
      (command) => command.phase === "implementing" && command.argv[0] === "bash",
    );
    expect(shellCommand).toBeDefined();
    expect(shellCommand?.argv).toEqual(["bash", "-lc", "printf agent-shell"]);

    const started = agentEvents.find((event) => event.type === "agent.tool_started");
    const finished = agentEvents.find((event) => event.type === "agent.tool_completed");
    const commandStarted = events.find(
      (event) =>
        event.type === "command.started" &&
        event.data?.commandExecutionId === started?.data?.commandExecutionId,
    );
    const commandFinished = events.find(
      (event) =>
        event.type === "command.completed" &&
        event.data?.commandExecutionId === finished?.data?.commandExecutionId,
    );
    expect(started?.data?.commandExecutionId).toEqual(expect.any(String));
    expect(finished?.data?.commandExecutionId).toBe(started?.data?.commandExecutionId);
    expect(commandStarted?.data?.phase).toBe("Implement change");
    expect(commandFinished?.data?.phase).toBe("Implement change");
    expect(sandbox.sandboxes.every((entry) => entry.destroyed)).toBe(true);
  });

  it("runs one durable review revision before approving the corrected patch", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({
      script: [successfulSession("implementation-session"), successfulSession("revision-session")],
      reviewerScript: [{ review: revisingReview() }, { review: approvingReview() }],
    });
    const job = await createTestJob();
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    const completed = await waitForStatus(job.id, "completed");
    const events = await readEvents(job.id);
    const phases = events
      .filter((event) => event.type === "phase.started")
      .map((event) => event.data?.phase);

    expect(phases).toEqual([
      "Provision sandbox",
      "Establish test baseline",
      "Create plan",
      "Implement change",
      "Validate change",
      "Review patch",
      "Revise change",
      "Validate change",
      "Review patch",
      "Finalize",
    ]);
    expect(completed.reviewLoops).toBe(1);
    expect(completed.reviewDecision).toBe("approve");
    expect((await eventTypes(job.id)).filter((type) => type === "review.recorded")).toHaveLength(2);
    expect(
      (await eventTypes(job.id)).filter((type) => type === "validation.recorded"),
    ).toHaveLength(2);

    const reviewCheckpoint = events.find(
      (event) => event.type === "checkpoint.created" && event.data?.completedPhase === "reviewing",
    );
    expect(reviewCheckpoint?.data).toMatchObject({ resumePhase: "revising" });
    const revisionCheckpoint = events.find(
      (event) => event.type === "checkpoint.created" && event.data?.completedPhase === "revising",
    );
    expect(revisionCheckpoint?.data).toMatchObject({ resumePhase: "testing" });

    const reviewArtifacts = (await listArtifacts(job.id)).filter(
      (artifact) => artifact.type === "review_report",
    );
    expect(reviewArtifacts).toHaveLength(2);
  });

  it("cancels a hanging session within one heartbeat and records an aborted ending", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({ script: [{ events: [sessionStarted()], hang: true }] });
    const job = await createTestJob();
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });
    await waitFor(
      async () =>
        (await readEvents(job.id)).some((event) => event.type === "agent.session_started")
          ? true
          : null,
      { label: "the coding session to start" },
    );

    const requestedAt = Date.now();
    await expect(requestJobCancellation(job.id, queue.queue)).resolves.toMatchObject({
      outcome: "cancel_requested",
    });

    const cancelled = await waitForStatus(job.id, "cancelled");
    expect(cancelled.failureCategory).toBe("cancelled");
    expect(Date.now() - requestedAt).toBeLessThan(TEST_CONFIG.heartbeatSeconds * 1_000 + 1_500);

    const events = await readEvents(job.id);
    expect(events.find((event) => event.type === "agent.session_ended")?.data).toMatchObject({
      stopReason: "aborted",
    });
    expect(events.map((event) => event.type)).not.toContain("job.completed");
    expect(agent.sessions.at(-1)?.stopped).toBe(true);
  });

  it("lands in budget_exceeded when a scripted session crosses the tool ceiling", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({
      script: [
        {
          events: [
            sessionStarted(),
            { type: "turn_started", turn: 0 },
            {
              type: "tool_started",
              turn: 0,
              toolCallId: "call-1",
              toolName: "read",
              argsPreview: "{}",
            },
            {
              type: "tool_started",
              turn: 0,
              toolCallId: "call-2",
              toolName: "read",
              argsPreview: "{}",
            },
          ],
        },
      ],
    });
    const job = await createTestJob({ maxToolCalls: 1 });
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    const exceeded = await waitForStatus(job.id, "budget_exceeded");
    expect(exceeded.failureCategory).toBe("budget_exceeded");
    const breach = await waitFor(
      async () =>
        (await readEvents(job.id)).find((event) => event.type === "agent.budget_exceeded"),
      { label: "the persisted budget event" },
    );
    expect(breach.data).toMatchObject({
      budget: "tool_calls",
      budgetValue: 2,
      budgetLimit: 1,
    });
    expect(
      (await eventTypes(job.id)).filter((type) => type === "job.retry_scheduled"),
    ).toHaveLength(0);
    expect(agent.sessions.at(-1)?.stopped).toBe(true);
  });

  it("retries a provider 429 and completes the next scripted attempt", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({
      script: [
        { events: [], throws: new AgentUnavailableError("provider returned 429") },
        successfulSession("fake-session-2"),
      ],
    });
    const job = await createTestJob();
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    const completed = await waitForStatus(job.id, "completed");
    expect(completed.attemptCount).toBe(2);
    // Four sessions, not five: the first attempt planned before its
    // implementation session hit the 429, and that plan was acknowledged by a
    // phase-boundary checkpoint. The retry resumes at `implementing` and spends
    // nothing on a second planner before the final reviewer.
    expect(agent.starts.map((start) => start.role)).toEqual([
      "planner",
      "implementer",
      "implementer",
      "reviewer",
    ]);
    expect(
      (await eventTypes(job.id)).filter((type) => type === "job.retry_scheduled"),
    ).toHaveLength(1);
  });

  it("does not retry a bad-key provider failure", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({
      script: [{ events: [], throws: new AgentFailedError("invalid provider key") }],
    });
    const job = await createTestJob();
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    const failed = await waitForStatus(job.id, "failed");
    expect(failed.failureCategory).toBe("agent_failed");
    expect(failed.attemptCount).toBe(1);
    expect(agent.starts).toHaveLength(2);
    expect(
      (await eventTypes(job.id)).filter((type) => type === "job.retry_scheduled"),
    ).toHaveLength(0);
  });

  it("spends tool calls from the totals a previous attempt persisted", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({
      script: [
        {
          events: [
            sessionStarted(),
            { type: "turn_started", turn: 0 },
            {
              type: "tool_started",
              turn: 0,
              toolCallId: "call-1",
              toolName: "read",
              argsPreview: "{}",
            },
            {
              type: "tool_started",
              turn: 0,
              toolCallId: "call-2",
              toolName: "read",
              argsPreview: "{}",
            },
          ],
        },
      ],
    });
    const job = await createTestJob({ maxToolCalls: 3 });
    // What an interrupted attempt left behind. This session's second tool call
    // is the job's fourth, so the ceiling is crossed one call into the session
    // rather than three - which is what a per-session counter would have allowed.
    await patchTestJob(job.id, { totalToolCalls: 2, totalModelCalls: 1 });
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    await waitForStatus(job.id, "budget_exceeded");
    const breach = await waitFor(
      async () =>
        (await readEvents(job.id)).find((event) => event.type === "agent.budget_exceeded"),
      { label: "the persisted budget event" },
    );
    expect(breach.data).toMatchObject({
      budget: "tool_calls",
      budgetValue: 4,
      budgetLimit: 3,
    });
    // The counters that justify the terminal status are on the row, and they got
    // there before the status did.
    const row = await readJob(job.id);
    expect(row.totalToolCalls).toBe(4);
    expect(row.totalModelCalls).toBe(2);
  });

  it("never starts a session for a job that has already spent its model calls", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({ script: [{ events: [sessionStarted()] }] });
    const job = await createTestJob({ maxModelCalls: 5 });
    await patchTestJob(job.id, { totalModelCalls: 5 });
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    const exceeded = await waitForStatus(job.id, "budget_exceeded");
    expect(exceeded.failureCategory).toBe("budget_exceeded");
    // The planner is the first session a job runs, and it is refused before the
    // provider is contacted at all.
    expect(agent.starts).toHaveLength(0);
  });

  it("times a job out on arrival when its deadline passed while it was queued", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({ script: [{ events: [sessionStarted()] }] });
    const job = await createTestJob({ maxDurationSeconds: 60 });
    // A job that started an hour ago on a worker that is now gone. Its deadline
    // is fixed and has passed, and no amount of waiting for a free worker
    // extends it.
    await patchTestJob(job.id, {
      startedAt: new Date(Date.now() - 3_600_000),
      deadlineAt: new Date(Date.now() - 60_000),
    });
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    const timedOut = await waitForStatus(job.id, "timed_out");
    expect(timedOut.failureCategory).toBe("timed_out");
    expect(timedOut.failureReason).toContain("waiting for a worker");
    // Nothing was built to discover that: no container, no clone, no session.
    expect(await eventTypes(job.id)).not.toContain("sandbox.created");
    expect(agent.starts).toHaveLength(0);
  });

  it("lets the job deadline stop a long session and land in timed_out", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({ script: [{ events: [sessionStarted()], hang: true }] });
    const job = await createTestJob({ maxDurationSeconds: 1 });
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    const timedOut = await waitForStatus(job.id, "timed_out");
    expect(timedOut.failureCategory).toBe("timed_out");
    expect(timedOut.failureReason).toContain("budget");
    expect(agent.sessions.at(-1)?.stopped).toBe(true);
    expect((await eventTypes(job.id)).filter((type) => type === "job.completed")).toHaveLength(0);
  });
});

/**
 * The deterministic validation opinion, through the real processor.
 *
 * The green path is already covered above - every completing test in this file
 * now walks validation on its way there. What is left is the half that matters
 * as much and is easy to leave untested: a run that produced nothing, and a run
 * that produced something worse than nothing. A validation pipeline that can
 * only report success has not validated anything.
 */
describe("validation through the worker", () => {
  it("records the comparison and keeps the diff on a green run", async () => {
    const sandbox = fixtureProvider();
    const agent = new FakeCodingAgent({ script: [successfulSession()] });
    const job = await createTestJob();
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    await waitForStatus(job.id, "completed");
    const events = await readEvents(job.id);
    const artifacts = await listArtifacts(job.id);

    // The fixture's suite passes before and after, which is the path a feature
    // request takes rather than the path a bug fix does. Its absent typecheck
    // and lint scripts keep the M7 aggregate honestly unverified.
    expect(events.find((event) => event.type === "validation.recorded")?.data).toMatchObject({
      validation: "unverified",
      filesChanged: 1,
      insertions: 1,
      deletions: 1,
    });
    expect(
      events.find(
        (event) => event.type === "validation.check_recorded" && event.data?.check === "test",
      )?.data,
    ).toMatchObject({ checkOutcome: "verified" });
    // Seven, in the order the run produced them: analyzing keeps its report,
    // planning persists the plan, testing keeps the diff and report, reviewing
    // keeps its verdict, and finalizing keeps the session's own account.
    expect(artifacts.map((artifact) => artifact.type)).toEqual([
      "baseline_report",
      "implementation_plan",
      "diff",
      "diff_stat",
      "validation_report",
      "review_report",
      "implementation_summary",
    ]);
    const diff = artifacts.find((artifact) => artifact.type === "diff");
    const summary = artifacts.find((artifact) => artifact.type === "implementation_summary");
    expect(diff?.byteSize).toBe(Buffer.byteLength(DIFF, "utf8"));
    // The last thing the model said, read back out of the event log rather than
    // handed across the phase boundary - which is what makes this survive a
    // resume in a process that never ran the session.
    expect(await getArtifact(job.id, summary!.id)).toMatchObject({
      content: "I found the fixture.",
      metadata: { present: true },
      phase: "finalizing",
    });
    // Every artifact row has an event pointing at it, and it resolves.
    const recorded = events.filter((event) => event.type === "artifact.recorded");
    expect(recorded.map((event) => event.data?.artifactId)).toEqual(
      artifacts.map((artifact) => artifact.id),
    );

    // The closing line, and it is genuinely last among what the phases write:
    // everything after it belongs to the processor closing the job out.
    const summarized = events.findIndex((event) => event.type === "run.summarized");
    expect(events[summarized]?.data).toMatchObject({
      validation: "unverified",
      filesChanged: 1,
      insertions: 1,
      deletions: 1,
    });
    expect(recorded.every((event) => event.id < events[summarized]!.id)).toBe(true);
    expect(summarized).toBeLessThan(events.findIndex((event) => event.type === "job.completed"));
  });

  it("fails a session that changed nothing with no_changes_produced", async () => {
    // The most interesting failure this milestone can surface: a session that
    // ended cleanly while the diff is empty did not do the task, and it will do
    // the same thing again on a second attempt. Terminal, therefore, and the
    // attempt count is the proof.
    const sandbox = fixtureProvider([
      { match: (argv) => argv[0] === "git" && argv[1] === "diff", stdout: "" },
    ]);
    const agent = new FakeCodingAgent({ script: [successfulSession()] });
    const job = await createTestJob();
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    const failed = await waitForStatus(job.id, "failed");
    expect(failed.failureCategory).toBe("no_changes_produced");
    expect(failed.attemptCount).toBe(1);
    expect((await listArtifacts(job.id)).map((artifact) => artifact.type)).toEqual([
      "baseline_report",
      "implementation_plan",
    ]);
  });

  it("fails a session that broke a green suite, and keeps the diff that broke it", async () => {
    // Two runs of the same command with two different answers: green at
    // `analyzing`, red at `testing`. That is a regression, and the diff is the
    // most valuable thing to keep from it.
    let suiteRuns = 0;
    const sandbox = fixtureProvider([
      {
        match: (argv) => argv[0] === "npm" && argv[1] === "run" && suiteRuns++ > 0,
        exitCode: 1,
        stdout: "1 failed | 4 passed\n",
      },
    ]);
    const agent = new FakeCodingAgent({ script: [successfulSession()] });
    const job = await createTestJob();
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    const failed = await waitForStatus(job.id, "failed");
    expect(failed.failureCategory).toBe("validation_failed");
    expect(failed.attemptCount).toBe(1);

    const events = await readEvents(job.id);
    expect(events.find((event) => event.type === "baseline.recorded")?.data).toMatchObject({
      baseline: "passed",
    });
    expect(events.find((event) => event.type === "validation.recorded")?.data).toMatchObject({
      validation: "regressed",
    });
    expect((await listArtifacts(job.id)).map((artifact) => artifact.type)).toEqual([
      "baseline_report",
      "implementation_plan",
      "diff",
      "diff_stat",
      "validation_report",
    ]);
  });

  it("records a fixed outcome when a red baseline becomes green", async () => {
    let suiteRuns = 0;
    const sandbox = fixtureProvider([
      {
        match: (argv) => argv[0] === "npm" && argv[1] === "run" && suiteRuns++ === 0,
        exitCode: 1,
        stdout: "2 failed | 8 passed\n",
      },
    ]);
    const agent = new FakeCodingAgent({ script: [successfulSession()] });
    const job = await createTestJob();
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    await waitForStatus(job.id, "completed");
    const events = await readEvents(job.id);
    const artifacts = await listArtifacts(job.id);

    expect(events.find((event) => event.type === "baseline.recorded")?.data).toMatchObject({
      baseline: "failed",
    });
    expect(events.find((event) => event.type === "validation.recorded")?.data).toMatchObject({
      validation: "unverified",
    });
    expect(
      events.find(
        (event) => event.type === "validation.check_recorded" && event.data?.check === "test",
      )?.data,
    ).toMatchObject({ checkOutcome: "fixed" });
    expect(artifacts.map((artifact) => artifact.type)).toEqual([
      "baseline_report",
      "implementation_plan",
      "diff",
      "diff_stat",
      "validation_report",
      "review_report",
      "implementation_summary",
    ]);
  });

  it("keeps the diff when cancellation arrives during validation", async () => {
    let suiteRuns = 0;
    const sandbox = fixtureProvider([
      {
        match: (argv) => argv[0] === "npm" && argv[1] === "run" && suiteRuns++ > 0,
        hang: true,
      },
    ]);
    const agent = new FakeCodingAgent({ script: [successfulSession()] });
    const job = await createTestJob();
    await requestJobRun(job.id, queue.queue);

    worker = startTestWorker({ queue: queue.queue, phases: agentPipeline(sandbox, agent) });

    await waitFor(
      async () => {
        const events = await readEvents(job.id);
        const diffRecorded = events.some(
          (event) => event.type === "artifact.recorded" && event.data?.artifactType === "diff",
        );
        const validationStarted = events.some(
          (event) =>
            event.type === "command.started" &&
            event.data?.phase === "Validate change" &&
            event.data.argv?.[0] === "npm",
        );
        return diffRecorded && validationStarted ? true : null;
      },
      { label: "validation to start after the diff was persisted" },
    );

    await expect(requestJobCancellation(job.id, queue.queue)).resolves.toMatchObject({
      outcome: "cancel_requested",
    });

    const cancelled = await waitForStatus(job.id, "cancelled");
    expect(cancelled.failureCategory).toBe("cancelled");

    const events = await readEvents(job.id);
    expect(events.some((event) => event.type === "agent.session_ended")).toBe(true);
    expect(events.some((event) => event.type === "validation.recorded")).toBe(false);
    expect((await listArtifacts(job.id)).map((artifact) => artifact.type)).toEqual([
      "baseline_report",
      "implementation_plan",
      "diff",
      "diff_stat",
    ]);
  });
});
