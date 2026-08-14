import { randomUUID } from "node:crypto";

import {
  CommandTimedOutError,
  type AgentToolbox,
  type RecordedCommand,
  type Sandbox,
  type SandboxSpec,
} from "@rivet/core";
import { createToolOperations, withToolCall } from "@rivet/agent";
import { closeDb } from "@rivet/database";
import { DockerSandboxProvider } from "@rivet/sandbox";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_IMAGE } from "../../src/config";

const REPO_DIR = "/home/node/workspace/repo";
const controller = new AbortController();
const provider = new DockerSandboxProvider({
  workerId: `agent-tools-suite-${process.pid}`,
  reapGraceMs: 0,
});
const owned = new Set<Sandbox>();

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    jobId: randomUUID(),
    image: process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
    workdir: process.env.SANDBOX_WORKDIR ?? "/home/node/workspace",
    memoryBytes: 256 * 1_024 * 1_024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 64,
    env: {},
    labels: {},
    ...overrides,
  };
}

async function create(overrides: Partial<SandboxSpec> = {}): Promise<Sandbox> {
  const sandbox = await provider.create(spec(overrides), controller.signal);
  owned.add(sandbox);
  return sandbox;
}

function toolLayer(
  sandbox: Sandbox,
  options: { outputMaxBytes?: number; fileMaxBytes?: number } = {},
) {
  const commands: RecordedCommand[] = [];
  const fatal: unknown[] = [];
  let commandNumber = 0;

  const toolbox: AgentToolbox = {
    readFile: (path, signal) =>
      sandbox.getFile(path, { maxBytes: options.fileMaxBytes ?? 4_096 }, signal),
    writeFile: (path, content, signal) => sandbox.putFile(path, content, signal),
    exec: async (input) => {
      const result = await sandbox.exec({
        argv: input.argv,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        signal: controller.signal,
        maxOutputBytes: 64 * 1_024,
      });
      const sequence = ++commandNumber;
      return {
        ...result,
        commandId: sequence,
        commandExecutionId: `agent-command-${sequence}`,
      };
    },
  };

  return {
    operations: createToolOperations({
      toolbox,
      repoDir: REPO_DIR,
      outputMaxBytes: options.outputMaxBytes ?? 4_096,
      commandTimeoutMs: 1_000,
      signal: controller.signal,
      onFatal: (error) => fatal.push(error),
      onCommand: (_toolCallId, command) => commands.push(command),
    }),
    commands,
    fatal,
  };
}

afterEach(async () => {
  await Promise.all([...owned].map((sandbox) => sandbox.destroy()));
  owned.clear();
});

afterAll(async () => {
  await closeDb();
});

describe("sandbox-backed coding-agent tools", () => {
  it("reads, writes, edits, and runs bash inside the real container", async () => {
    const sandbox = await create();
    const file = `${REPO_DIR}/src/sum.js`;
    await sandbox.putFile(file, "module.exports = 1;\n", controller.signal);
    const test = toolLayer(sandbox);
    const output: Buffer[] = [];

    await expect(test.operations.read.readFile(file)).resolves.toEqual(
      Buffer.from("module.exports = 1;\n"),
    );
    await test.operations.write.writeFile(file, "module.exports = 2;\n");

    const current = await test.operations.edit.readFile(file);
    await test.operations.edit.writeFile(
      file,
      current.toString("utf8").replace("module.exports = 2", "module.exports = 3"),
    );

    await withToolCall("tool-call-1", () =>
      test.operations.bash.exec("printf agent-shell", REPO_DIR, {
        onData: (chunk) => output.push(chunk),
        signal: controller.signal,
        timeout: 1,
      }),
    );

    await expect(
      sandbox.getFile(file, { maxBytes: 4_096 }, controller.signal),
    ).resolves.toMatchObject({ content: "module.exports = 3;\n", truncated: false });
    expect(Buffer.concat(output).toString("utf8")).toBe("agent-shell");
    expect(test.commands).toHaveLength(1);
    expect(test.commands[0]).toMatchObject({
      argv: ["bash", "-lc", "printf agent-shell"],
      cwd: REPO_DIR,
    });
  });

  it("caps file reads and command output before they reach the model", async () => {
    const sandbox = await create();
    const largeFile = `${REPO_DIR}/large.txt`;
    await sandbox.putFile(largeFile, "A".repeat(128), controller.signal);
    const test = toolLayer(sandbox, { fileMaxBytes: 16, outputMaxBytes: 12 });
    const output: Buffer[] = [];

    const read = await test.operations.read.readFile(largeFile);
    expect(read.toString("utf8")).toContain("[rivet: this file was truncated");
    await expect(test.operations.edit.readFile(largeFile)).rejects.toMatchObject({
      name: "SandboxFileError",
      reason: "not_a_file",
    });

    await test.operations.bash.exec("printf 0123456789abcdefghijklmnopqrstuvwxyz", REPO_DIR, {
      onData: (chunk) => output.push(chunk),
      signal: controller.signal,
      timeout: 1,
    });
    expect(Buffer.concat(output).toString("utf8")).toContain("[rivet: showing the last 12 bytes");
    // The durable command result keeps the sandbox transcript cap, while the
    // smaller model-facing cap above is applied only to `onData`.
    expect(test.commands[0]?.truncated).toBe(false);
  });

  it("turns a command timeout into a fatal sandbox error", async () => {
    const sandbox = await create();
    await sandbox.putFile(`${REPO_DIR}/placeholder.txt`, "fixture\n", controller.signal);
    const test = toolLayer(sandbox);

    await expect(
      test.operations.bash.exec("node -e 'setInterval(() => {}, 1000)'", REPO_DIR, {
        onData: () => undefined,
        signal: controller.signal,
        timeout: 0.1,
      }),
    ).rejects.toBeInstanceOf(CommandTimedOutError);
    expect(test.fatal[0]).toBeInstanceOf(CommandTimedOutError);
    expect(test.commands[0]).toMatchObject({ timedOut: true, exitCode: null });
  });
});
