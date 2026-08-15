import type { CodingAgentEvent } from "@rivet/core";
import { buildPipeline, type AgentOptions, type PipelineOptions } from "@rivet/core";
import {
  approvingReview,
  FakeCodingAgent,
  revisingReview,
  type ScriptedSession,
} from "@rivet/agent";
import { FakeSandboxProvider, type ScriptedCommand } from "@rivet/sandbox";

export const REPO_DIR = "/home/node/workspace/repo";
export const COMMIT = "9f2b0c1a4d5e6f708192a3b4c5d6e7f809112233";
export const LISTING = ".\n..\n.git\npackage.json\npackage-lock.json\nREADME.md\ntest.js\n";
export const TRACKED = "package.json\npackage-lock.json\nREADME.md\ntest.js\n";
export const MANIFEST = JSON.stringify({
  name: "rivet-agent-fixture",
  scripts: { test: "node test.js" },
});

/** A stable, non-empty patch keeps validation and boundary checkpoints real. */
export const DIFF = [
  "diff --git a/test.js b/test.js",
  "--- a/test.js",
  "+++ b/test.js",
  "@@ -1 +1 @@",
  "-const ok = false;",
  "+const ok = true;",
  "",
].join("\n");
export const NUMSTAT = "1\t1\ttest.js\n";

export const PIPELINE_OPTIONS: Omit<PipelineOptions, "sandbox" | "agent"> = {
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

export const AGENT_OPTIONS: Omit<AgentOptions, "coding"> = {
  sessionTimeoutMs: 5_000,
  maxTurns: 8,
  previewMaxBytes: 512,
  fileMaxBytes: 4_096,
};

export const USAGE = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.25,
} as const;

/**
 * The same tiny repository answers every command a real pipeline needs.
 * Commands not listed here succeed with empty output, which is enough for the
 * fake's read-only reviewer searches and keeps the test focused on workflow
 * behaviour rather than on a second fake command implementation.
 */
export function fixtureProvider(first: ScriptedCommand[] = []): FakeSandboxProvider {
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

export function reviewPipeline(
  sandbox: FakeSandboxProvider,
  coding: FakeCodingAgent,
): ReturnType<typeof buildPipeline> {
  return buildPipeline({
    ...PIPELINE_OPTIONS,
    sandbox,
    agent: { ...AGENT_OPTIONS, coding },
  });
}

export function successfulSession(sessionId: string): ScriptedSession {
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
          toolCallId: `${sessionId}-call`,
          toolName: "bash",
          argsPreview: '{"command":"printf agent-shell"}',
          commandExecutionId: command.commandExecutionId,
        },
        {
          type: "tool_completed",
          turn: 0,
          toolCallId: `${sessionId}-call`,
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

export function reviewerSession(
  sessionId: string,
  review: ReturnType<typeof approvingReview>,
): ScriptedSession {
  return {
    events: [
      {
        type: "session_started",
        sessionId,
        model: "fixture-model",
        provider: "fixture-provider",
        toolNames: ["list_files", "read", "search_text", "submit_review"],
      },
    ],
    review,
  };
}

export function reviewerWithoutVerdict(sessionId = "reviewer-no-verdict"): ScriptedSession {
  return {
    events: [
      {
        type: "session_started",
        sessionId,
        model: "fixture-model",
        provider: "fixture-provider",
        toolNames: ["list_files", "read", "search_text", "submit_review"],
      },
    ],
    review: null,
  };
}

export { approvingReview, revisingReview, FakeCodingAgent };
export type { ScriptedCommand, ScriptedSession };
