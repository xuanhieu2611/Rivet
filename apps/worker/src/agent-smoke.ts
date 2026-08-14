/* eslint-disable no-console -- this is a local transcript command */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import type {
  AgentToolbox,
  CodingAgentEvent,
  CodingAgentSession,
  CodingAgentSpec,
  RecordedCommand,
  Sandbox,
} from "@rivet/core";
import { PiCodingAgent } from "@rivet/agent";
import { DockerSandboxProvider } from "@rivet/sandbox";
import { config as loadEnvFile } from "dotenv";

import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_PROVIDER,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_WORKDIR,
} from "./config";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_TIMEOUT_MS = 180_000;

/**
 * A local, model-backed proof of the M4 boundary.
 *
 * This intentionally does not create a Postgres job. The worker integration
 * suite already proves the processor and event log with a fake agent; this
 * command proves that Pi can use the same four sandbox-backed capabilities
 * against a tiny repository and prints the resulting session transcript.
 */
async function main(): Promise<void> {
  loadRootEnv();

  const provider = process.env.RIVET_MODEL_PROVIDER ?? DEFAULT_MODEL_PROVIDER;
  const model = process.env.RIVET_MODEL ?? DEFAULT_MODEL;
  if (provider === DEFAULT_MODEL_PROVIDER && !process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is required for pnpm demo:agent. Put it in .env.local or export it first.",
    );
  }

  const image = process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
  const workdir = process.env.SANDBOX_WORKDIR ?? DEFAULT_SANDBOX_WORKDIR;
  const commandTimeoutMs = numberEnv("SANDBOX_COMMAND_TIMEOUT_MS", DEFAULT_COMMAND_TIMEOUT_MS);
  const sessionTimeoutMs = numberEnv("AGENT_SESSION_TIMEOUT_MS", DEFAULT_SESSION_TIMEOUT_MS);
  const outputMaxBytes = numberEnv("AGENT_TOOL_OUTPUT_MAX_BYTES", 32_768);
  const previewMaxBytes = numberEnv("AGENT_PREVIEW_MAX_BYTES", 2_048);
  const fileMaxBytes = numberEnv("AGENT_FILE_MAX_BYTES", 262_144);
  const homeDir = await mkdtemp(join(tmpdir(), "rivet-agent-smoke-"));
  const controller = new AbortController();
  const sandboxProvider = new DockerSandboxProvider({
    workerId: `agent-smoke-${process.pid}`,
    reapGraceMs: 0,
  });

  let session: CodingAgentSession | undefined;
  let sandbox: Sandbox | undefined;
  const repoDir = `${workdir}/repo`;
  let commandNumber = 0;
  const commands: RecordedCommand[] = [];
  let finalUsage: SmokeUsage = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };

  try {
    sandbox = await sandboxProvider.create(
      {
        jobId: randomUUID(),
        image,
        workdir,
        memoryBytes: numberEnv("SANDBOX_MEMORY_MB", 512) * 1_024 * 1_024,
        nanoCpus: Math.round(numberEnv("SANDBOX_CPUS", 1) * 1_000_000_000),
        pidsLimit: numberEnv("SANDBOX_PIDS_LIMIT", 128),
        env: {},
        labels: {},
      },
      controller.signal,
    );

    await writeFixture(sandbox, repoDir, controller.signal);

    const tools: AgentToolbox = {
      readFile: (path, signal) => sandbox!.getFile(path, { maxBytes: fileMaxBytes }, signal),
      writeFile: (path, content, signal) => sandbox!.putFile(path, content, signal),
      exec: async (input) => {
        const result = await sandbox!.exec({
          argv: input.argv,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          signal: controller.signal,
          maxOutputBytes: 65_536,
        });
        const sequence = ++commandNumber;
        const command = {
          ...result,
          commandId: sequence,
          commandExecutionId: `smoke-command-${sequence}`,
        };
        commands.push(command);
        return command;
      },
    };

    const agent = new PiCodingAgent({
      model,
      provider,
      homeDir,
      outputMaxBytes,
      logger: {
        info: (details, message) => console.error(`[pi] ${message}`, details),
        warn: (details, message) => console.error(`[pi] ${message}`, details),
      },
    });
    const spec: CodingAgentSpec = {
      workdir: repoDir,
      task: {
        title: "Fix the off-by-one in sum()",
        description:
          "The sum(a, b) function returns one less than it should. Fix the bug and keep the " +
          "fixture test passing. Do not change the test to hide the defect.",
      },
      context: [
        "# Fixture repository",
        "",
        `The repository is at ${repoDir} inside a sandbox-backed Linux container.`,
        "The initial test is expected to fail because sum() contains a one-line bug.",
        "Dependencies are not needed. Run `node test.js` before and after the change.",
        "Files: package.json, sum.js, test.js.",
      ].join("\n"),
      sessionTimeoutMs,
      commandTimeoutMs,
      previewMaxBytes,
      limits: {
        maxTurns: numberEnv("AGENT_MAX_TURNS", 12),
        maxToolCalls: 50,
        maxModelCalls: 50,
        maxCostUsd: 1,
      },
    };

    console.log(`Starting Pi ${provider}/${model} against ${repoDir}`);
    session = await agent.start(spec, tools, controller.signal);
    for await (const event of session.run(controller.signal)) {
      printEvent(event);
      if (event.type === "session_ended") {
        finalUsage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          costUsd: event.usage.costUsd,
        };
      }
    }

    const verification = await sandbox.exec({
      argv: ["node", "test.js"],
      cwd: repoDir,
      timeoutMs: commandTimeoutMs,
      signal: controller.signal,
      maxOutputBytes: 16_384,
    });
    console.log(
      `[verification] exit=${verification.exitCode} ${verification.stdout.trim()} ${verification.stderr.trim()}`.trim(),
    );
    console.log(
      `[usage] input=${finalUsage.inputTokens} output=${finalUsage.outputTokens} ` +
        `cost=${formatCost(finalUsage.costUsd)} commands=${commands.length}`,
    );
    if (verification.exitCode !== 0) process.exitCode = 1;
  } finally {
    await session?.stop();
    await sandbox?.destroy();
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function writeFixture(sandbox: Sandbox, repoDir: string, signal: AbortSignal): Promise<void> {
  await sandbox.putFile(
    `${repoDir}/package.json`,
    JSON.stringify({
      name: "rivet-agent-smoke",
      private: true,
      scripts: { test: "node test.js" },
    }) + "\n",
    signal,
  );
  await sandbox.putFile(`${repoDir}/sum.js`, "module.exports = (a, b) => a + b - 1;\n", signal);
  await sandbox.putFile(
    `${repoDir}/test.js`,
    [
      "const sum = require('./sum');",
      "if (sum(2, 3) !== 5) {",
      "  console.error(`expected 5, got ${sum(2, 3)}`);",
      "  process.exit(1);",
      "}",
      "console.log('sum test passed');",
      "",
    ].join("\n"),
    signal,
  );
}

interface SmokeUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

function printEvent(event: CodingAgentEvent): void {
  switch (event.type) {
    case "session_started":
      console.log(
        `[${event.type}] ${event.provider}/${event.model} tools=${event.toolNames.join(",")}`,
      );
      return;
    case "assistant_message":
      console.log(`[${event.type}] ${event.text}`);
      return;
    case "tool_started":
      console.log(`[${event.type}] ${event.toolName} ${event.argsPreview}`);
      return;
    case "tool_completed":
      console.log(
        `[${event.type}] ${event.toolName} error=${event.isError} duration=${event.durationMs}ms ` +
          `${event.resultPreview}`,
      );
      return;
    case "usage":
      console.log(
        `[${event.type}] turn=${event.turn} input=${event.usage.inputTokens} ` +
          `output=${event.usage.outputTokens} cost=${formatCost(event.usage.costUsd)}`,
      );
      return;
    case "turn_started":
      console.log(`[${event.type}] ${event.turn}`);
      return;
    case "session_ended":
      console.log(
        `[${event.type}] reason=${event.reason} turns=${event.turns} ` +
          `cost=${formatCost(event.usage.costUsd)}`,
      );
      return;
    case "turn_completed":
      return;
  }
}

function formatCost(cost: number | null): string {
  return cost === null ? "unavailable" : `$${cost.toFixed(4)}`;
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadRootEnv(): void {
  const root = resolve(import.meta.dirname, "../../..");
  loadEnvFile({ path: [join(root, ".env.local"), join(root, ".env")], quiet: true });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
