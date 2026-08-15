import type { JobDetail, ReviewReport, ValidationReport } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import type {
  AgentToolbox,
  CodingAgent,
  CodingAgentEvent,
  CodingAgentSession,
  CodingAgentSpec,
  ReviewerAgentToolbox,
} from "../agent/coding-agent";
import { ReviewNotProducedError, ReviewerRejectionError } from "../agent/errors";
import type { Sandbox, SandboxProvider } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import type {
  PhaseArtifactInput,
  PhaseContext,
  PhaseEventInput,
  PhaseExecInput,
  RecordedCommand,
} from "./phase-context";
import type { AgentOptions, Phase, PipelineOptions } from "./phases";
import { reviewingPhase } from "./reviewing-phase";

const REVIEW: ReviewReport = {
  decision: "approve",
  blockingIssues: [],
  nonBlockingIssues: [],
  confidence: 0.9,
  summary: "The patch addresses the issue and the validation evidence is consistent.",
};

const REVISION: ReviewReport = {
  decision: "revise",
  blockingIssues: [
    {
      title: "The named boundary is still uncovered",
      detail: "The implementation does not handle the empty input named by the issue.",
      paths: ["src/order.ts"],
      category: "edge_case",
    },
  ],
  nonBlockingIssues: [],
  confidence: 0.8,
  summary: "The main path is correct, but the named boundary still needs a change.",
};

const PLAN = {
  problemInterpretation: "The order total is wrong at a boundary.",
  relevantComponents: ["src/order.ts"],
  reproductionStrategy: ["Read the order tests."],
  implementationApproach: ["Handle the boundary explicitly."],
  validationPlan: ["Run the test suite."],
  riskAreas: ["Existing totals."],
};

const VALIDATION_REPORT: ValidationReport = {
  outcome: "verified",
  checks: [
    {
      kind: "test",
      status: "passed",
      source: "package_json",
      argv: ["pnpm", "test"],
      exitCode: 0,
      durationMs: 10,
      tests: {
        framework: "vitest",
        total: 2,
        passed: 2,
        failed: 0,
        skipped: 0,
        failures: [],
        parsed: true,
      },
      baseline: "passed",
      outcome: "verified",
    },
  ],
};

const REPO_DIR = "/home/node/workspace/repo";
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
  reviewLoops: 0,
  reviewDecision: null,
  reviewBlockingCount: null,
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

class ScriptedReviewer implements CodingAgent {
  readonly specs: CodingAgentSpec[] = [];
  stopCount = 0;

  constructor(
    private readonly report: ReviewReport | null,
    private readonly reports: ReviewReport[] = [],
  ) {}

  start(
    spec: CodingAgentSpec,
    tools: AgentToolbox,
    _signal: AbortSignal,
  ): Promise<CodingAgentSession> {
    this.specs.push(spec);
    if (tools.role !== "reviewer") throw new Error("expected reviewer capabilities");
    const reviewerTools: ReviewerAgentToolbox = tools;
    const sessionNumber = this.specs.length;
    const report = this.reports[sessionNumber - 1] ?? this.report;

    return Promise.resolve({
      id: `reviewer-session-${sessionNumber}`,
      async *run(signal: AbortSignal): AsyncIterable<CodingAgentEvent> {
        signal.throwIfAborted();
        await reviewerTools.listFiles(signal);
        await reviewerTools.readFile(`${REPO_DIR}/src/order.ts`, signal);
        await reviewerTools.searchText("orderTotal", signal);
        if (report !== null) await reviewerTools.submitReview(report, signal);
        yield {
          type: "session_started",
          sessionId: `reviewer-session-${sessionNumber}`,
          model: "fake",
          provider: "fake",
          toolNames: ["list_files", "read", "search_text", "submit_review"],
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
        yield { type: "session_ended", reason: "completed", turns: 1, usage: { ...NO_USAGE } };
      },
      stop: () => {
        this.stopCount += 1;
        return Promise.resolve();
      },
    });
  }
}

const NO_USAGE = {
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

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

function harness({
  job = JOB,
  reviewer = new ScriptedReviewer(REVIEW),
  reviewReport = null,
}: {
  job?: JobDetail;
  reviewer?: ScriptedReviewer;
  reviewReport?: ReviewReport | null;
} = {}) {
  const holder = new SandboxHolder();
  const controller = new AbortController();
  const events: PhaseEventInput[] = [];
  const artifacts: PhaseArtifactInput[] = [];
  const commands: string[][] = [];
  const reviewPatches: Record<string, unknown>[] = [];
  let latestReviewReads = 0;

  const sandbox: Sandbox = {
    id: "sandbox-1",
    exec: () => Promise.reject(new Error("review reads through the phase context")),
    getFile: (path) => {
      if (path.endsWith("src/order.ts")) {
        return Promise.resolve({ content: "export function orderTotal() {}\n", truncated: false });
      }
      return Promise.reject(new Error(`unexpected read: ${path}`));
    },
    putFile: () => Promise.reject(new Error("reviewer cannot write")),
    destroy: () => Promise.resolve(),
  };
  holder.set(sandbox);

  const provider: SandboxProvider = {
    create: () => Promise.reject(new Error("not used")),
    reap: () => Promise.resolve([]),
  };

  const context: PhaseContext = {
    job,
    phase: { status: "reviewing", label: "Review patch", durationMs: 0, recovery: "replay" },
    sandboxes: holder,
    signal: controller.signal,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    exec: (input) => {
      commands.push(input.argv);
      const stdout =
        input.argv[0] === "ls"
          ? ".\n..\nREADME.md\npackage.json\nsrc\n"
          : input.argv[0] === "git" && input.argv[1] === "ls-files"
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
    artifact: (input) => {
      artifacts.push(input);
      return Promise.resolve(42);
    },
    readBaseline: () => Promise.resolve("passed"),
    readBaselineReport: () => Promise.resolve(null),
    readImplementationPlan: () => Promise.resolve(PLAN),
    readSummary: () => Promise.resolve("I fixed the order total."),
    readValidation: () => Promise.resolve(null),
    readValidationReport: () => Promise.resolve(VALIDATION_REPORT),
    readLatestArtifactContent: (type) => {
      const artifacts: Record<string, string | null> = {
        diff: "diff --git a/src/order.ts b/src/order.ts\n+export function orderTotal() {}\n",
        diff_stat: "1\t0\tsrc/order.ts\n",
        implementation_summary: null,
      };
      return Promise.resolve(artifacts[type] ?? null);
    },
    readLatestReviewReport: () => {
      latestReviewReads += 1;
      return Promise.resolve(reviewReport);
    },
    recordProvisioning: () => Promise.resolve(),
    recordAgentUsage: () => Promise.resolve(),
    recordReview: (patch) => {
      reviewPatches.push(patch);
      return Promise.resolve();
    },
    readLatestCheckpoint: () => Promise.resolve(null),
    captureWorkspace: () => Promise.reject(new Error("review does not checkpoint directly")),
    checkpoint: () => Promise.reject(new Error("review does not checkpoint directly")),
  };

  const options: PipelineOptions = { ...OPTIONS, sandbox: provider };
  const agent: AgentOptions = { ...AGENT, coding: reviewer };

  return {
    agent,
    context,
    options,
    events,
    artifacts,
    commands,
    reviewPatches,
    latestReviewReads: () => latestReviewReads,
    controller,
    reviewer,
  };
}

function cycle(): { revising: Phase; testing: Phase; reviewing: Phase } {
  return {
    revising: { status: "revising", label: "Revise change", durationMs: 0, recovery: "checkpoint" },
    testing: { status: "testing", label: "Validate change", durationMs: 0, recovery: "replay" },
    reviewing: { status: "reviewing", label: "Review patch", durationMs: 0, recovery: "replay" },
  };
}

describe("reviewingPhase", () => {
  it("gives a fresh reviewer durable evidence and persists an approval", async () => {
    const test = harness();

    await reviewingPhase(test.agent, test.options, cycle())(test.context);

    expect(test.reviewer.specs[0]?.role).toBe("reviewer");
    expect(test.reviewer.specs[0]?.context).toContain("Final diff");
    expect(test.reviewer.specs[0]?.context).toContain("orderTotal");
    expect(test.reviewer.specs[0]?.context).toContain('"outcome":"verified"');
    expect(test.reviewer.specs[0]?.context).toContain("Persisted implementation plan");
    expect(test.commands).toContainEqual(["git", "ls-files"]);
    expect(test.commands).toContainEqual([
      "git",
      "grep",
      "-n",
      "--no-color",
      "-e",
      "orderTotal",
      "--",
      ".",
    ]);
    expect(test.artifacts).toEqual([
      expect.objectContaining({ type: "review_report", requireComplete: true }),
    ]);
    expect(JSON.parse(test.artifacts[0]!.content)).toEqual(REVIEW);
    expect(test.events.find((event) => event.type === "review.recorded")?.data).toMatchObject({
      artifactId: 42,
      artifactType: "review_report",
      agentRole: "reviewer",
      reviewDecision: "approve",
      reviewLoop: 0,
      blockingCount: 0,
      nonBlockingCount: 0,
      confidence: 0.9,
    });
    expect(test.reviewPatches).toEqual([
      { reviewDecision: "approve", reviewLoops: 0, reviewBlockingCount: 0 },
    ]);
    expect(test.reviewer.stopCount).toBe(1);
  });

  it("records a blocking verdict and inserts the revision cycle", async () => {
    const job = { ...JOB, reviewLoops: 0, maxReviewLoops: 2 };
    const test = harness({ job, reviewer: new ScriptedReviewer(REVISION) });

    const directive = await reviewingPhase(test.agent, test.options, cycle())(test.context);

    if (directive?.kind !== "cycle") throw new Error("expected a cycle directive");
    expect(directive.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "revising" }),
        expect.objectContaining({ status: "testing" }),
        expect.objectContaining({ status: "reviewing" }),
      ]),
    );
    expect(test.context.job.reviewLoops).toBe(1);
    expect(test.events.map((event) => event.type)).toContain("review.revision_requested");
    expect(test.events.find((event) => event.type === "review.revision_requested")?.data).toEqual({
      reviewLoop: 0,
      reviewLoops: 1,
      maxReviewLoops: 2,
      blockingCount: 1,
    });
  });

  it("passes the previous durable verdict to a later review loop", async () => {
    const job = { ...JOB, reviewLoops: 1, maxReviewLoops: 2 };
    const test = harness({
      job,
      reviewer: new ScriptedReviewer(REVIEW),
      reviewReport: REVISION,
    });

    await reviewingPhase(test.agent, test.options, cycle())(test.context);

    expect(test.latestReviewReads()).toBe(1);
    expect(test.reviewer.specs[0]?.context).toContain("The named boundary is still uncovered");
  });

  it("fails with reviewer_rejection when the durable loop bound is spent", async () => {
    const job = { ...JOB, reviewLoops: 1, maxReviewLoops: 1 };
    const test = harness({ job, reviewer: new ScriptedReviewer(REVISION) });

    await expect(
      reviewingPhase(test.agent, test.options, cycle())(test.context),
    ).rejects.toBeInstanceOf(ReviewerRejectionError);

    expect(test.reviewPatches).toEqual([
      { reviewDecision: "revise", reviewLoops: 1, reviewBlockingCount: 1 },
    ]);
    expect(test.events.map((event) => event.type)).toContain("review.limit_reached");
    expect(test.events.find((event) => event.type === "review.limit_reached")?.data).toMatchObject({
      reviewLoops: 1,
      maxReviewLoops: 1,
      blockingCount: 1,
      failureCategory: "reviewer_rejection",
    });
  });

  it("fails when the session ends without submitting a verdict", async () => {
    const test = harness({ reviewer: new ScriptedReviewer(null) });

    await expect(
      reviewingPhase(test.agent, test.options, cycle())(test.context),
    ).rejects.toBeInstanceOf(ReviewNotProducedError);
    expect(test.artifacts).toEqual([]);
    expect(test.events.some((event) => event.type === "review.recorded")).toBe(false);
  });

  it("records a job-level skip without starting a reviewer session", async () => {
    const job = { ...JOB, reviewMode: "none" } as JobDetail;
    const test = harness({ job });

    await reviewingPhase(test.agent, test.options, cycle())(test.context);

    expect(test.reviewer.specs).toEqual([]);
    expect(test.events).toEqual([
      {
        type: "review.skipped",
        message: "Independent review skipped by the job.",
        data: { reviewMode: "none" },
      },
    ]);
    expect(test.artifacts).toEqual([]);
  });

  it("honors cancellation before creating the reviewer session", async () => {
    const test = harness();
    test.controller.abort(new Error("cancelled"));

    await expect(reviewingPhase(test.agent, test.options, cycle())(test.context)).rejects.toThrow(
      "cancelled",
    );
    expect(test.reviewer.specs).toEqual([]);
  });
});
