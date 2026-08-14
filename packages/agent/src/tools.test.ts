import type { AgentExecInput, AgentToolbox, RecordedCommand } from "@rivet/core";
import { CommandTimedOutError, SandboxFileError } from "@rivet/core";
import { describe, expect, it, vi } from "vitest";

import { AgentPathError } from "./paths";
import { createToolOperations, type ToolLayerOptions, withToolCall } from "./tools";

/**
 * The tool layer, tested with no Docker, no harness and no model.
 *
 * Everything here is a claim about containment or about what the model is
 * allowed to see, and both are properties of this file rather than of a
 * container. The `*.sbx.test.ts` suite is what proves the sandbox adapter
 * underneath; these prove that nothing between a model and that adapter widens
 * what it can reach.
 */

const REPO = "/home/node/workspace/repo";

interface Harness {
  operations: ReturnType<typeof createToolOperations>;
  files: Map<string, string>;
  commands: AgentExecInput[];
  fatals: unknown[];
  recorded: { toolCallId: string | undefined; command: RecordedCommand }[];
}

interface HarnessOptions {
  /** Stands in for the phase's own read bound, which the port leaves to it. */
  fileMaxBytes?: number;
  outputMaxBytes?: number;
  commandTimeoutMs?: number;
  signal?: AbortSignal;
  exec?: (input: AgentExecInput) => RecordedCommand;
  onCommand?: ToolLayerOptions["onCommand"];
}

function harness(options: HarnessOptions = {}): Harness {
  const files = new Map<string, string>([
    [`${REPO}/src/sum.ts`, "export const sum = (a: number, b: number) => a + b - 1;\n"],
  ]);
  const commands: AgentExecInput[] = [];
  const fatals: unknown[] = [];
  const recorded: Harness["recorded"] = [];

  const toolbox: AgentToolbox = {
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined) {
        return Promise.reject(new SandboxFileError(`${path} does not exist.`, "not_found"));
      }
      const bytes = Buffer.from(content, "utf8");
      const maxBytes = options.fileMaxBytes ?? Number.MAX_SAFE_INTEGER;
      const truncated = bytes.byteLength > maxBytes;
      return Promise.resolve({
        content: truncated ? bytes.subarray(0, maxBytes).toString("utf8") : content,
        truncated,
      });
    },
    writeFile: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    exec: (input) => {
      commands.push(input);
      return Promise.resolve(
        options.exec?.(input) ?? {
          argv: input.argv,
          cwd: input.cwd,
          exitCode: 0,
          stdout: "ok\n",
          stderr: "",
          truncated: false,
          timedOut: false,
          oomKilled: false,
          durationMs: 5,
          commandId: commands.length,
          commandExecutionId: `exec-${commands.length}`,
        },
      );
    },
  };

  const operations = createToolOperations({
    toolbox,
    repoDir: REPO,
    outputMaxBytes: options.outputMaxBytes ?? 1_024,
    commandTimeoutMs: options.commandTimeoutMs ?? 60_000,
    signal: options.signal ?? new AbortController().signal,
    onFatal: (error) => fatals.push(error),
    onCommand:
      options.onCommand ?? ((toolCallId, command) => recorded.push({ toolCallId, command })),
  });

  return { operations, files, commands, fatals, recorded };
}

describe("read operations", () => {
  it("reads a file from the sandbox", async () => {
    const { operations } = harness();

    await operations.read.access(`${REPO}/src/sum.ts`);
    const buffer = await operations.read.readFile(`${REPO}/src/sum.ts`);

    expect(buffer.toString("utf8")).toContain("export const sum");
  });

  it("refuses a path outside the repository at the first call, not the last", async () => {
    const { operations } = harness();

    await expect(operations.read.access("/etc/passwd")).rejects.toThrow(AgentPathError);
    await expect(operations.read.readFile("/etc/passwd")).rejects.toThrow(AgentPathError);
  });

  it("answers a missing file with something the model can act on", async () => {
    const { operations, fatals } = harness();

    await expect(operations.read.readFile(`${REPO}/nope.ts`)).rejects.toThrow(SandboxFileError);
    // Not a broken sandbox. A model guessing at a path is the loop working.
    expect(fatals).toEqual([]);
  });

  it("offers no image path, so every read is text", () => {
    const { operations } = harness();
    expect(operations.read.detectImageMimeType).toBeUndefined();
  });

  it("says so in the content when it handed back a prefix", async () => {
    const { operations } = harness({ fileMaxBytes: 20 });

    const buffer = await operations.read.readFile(`${REPO}/src/sum.ts`);

    expect(buffer.toString("utf8")).toContain("[rivet: this file was truncated");
  });
});

describe("edit operations", () => {
  it("refuses to read a truncated file, because the next step would rewrite it", async () => {
    const { operations } = harness({ fileMaxBytes: 20 });

    await expect(operations.edit.readFile(`${REPO}/src/sum.ts`)).rejects.toThrow(
      /too large to edit/,
    );
  });

  it("writes through to the sandbox", async () => {
    const { operations, files } = harness();

    await operations.edit.writeFile(`${REPO}/src/sum.ts`, "fixed\n");

    expect(files.get(`${REPO}/src/sum.ts`)).toBe("fixed\n");
  });

  it("refuses to write outside the repository", async () => {
    const { operations, files } = harness();

    await expect(operations.edit.writeFile("/etc/cron.d/evil", "x")).rejects.toThrow(
      AgentPathError,
    );
    expect(files.has("/etc/cron.d/evil")).toBe(false);
  });
});

describe("write operations", () => {
  it("creates a file and needs no separate directory call", async () => {
    const { operations, files } = harness();

    await operations.write.mkdir(`${REPO}/src/util`);
    await operations.write.writeFile(`${REPO}/src/util/x.ts`, "export const x = 1;\n");

    expect(files.get(`${REPO}/src/util/x.ts`)).toBe("export const x = 1;\n");
  });

  it("rejects an escaping directory before anything is written", async () => {
    const { operations } = harness();
    await expect(operations.write.mkdir("/usr/local/bin")).rejects.toThrow(AgentPathError);
  });
});

describe("bash operations", () => {
  it("runs a shell string as one argument, never as interpolation", async () => {
    const { operations, commands } = harness();

    const result = await operations.bash.exec("pnpm test -- --run", REPO, {
      onData: () => undefined,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(commands[0]?.argv).toEqual(["bash", "-lc", "pnpm test -- --run"]);
    expect(commands[0]?.cwd).toBe(REPO);
  });

  it("never forwards the harness's host environment into the container", async () => {
    const { operations, commands } = harness();

    await operations.bash.exec("env", REPO, {
      onData: () => undefined,
      env: { OPENROUTER_API_KEY: "sk-do-not-leak-this", PATH: "/usr/bin" },
    });

    // The port has no place to put an environment, and that is the point:
    // there is no expression here that could pass one through.
    expect(JSON.stringify(commands[0])).not.toContain("sk-do-not-leak-this");
  });

  it("honours a model's timeout downwards but never upwards", async () => {
    const { operations, commands } = harness({ commandTimeoutMs: 60_000 });

    await operations.bash.exec("sleep 1", REPO, { onData: () => undefined, timeout: 5 });
    await operations.bash.exec("sleep 1", REPO, { onData: () => undefined, timeout: 9_999 });
    await operations.bash.exec("sleep 1", REPO, { onData: () => undefined });

    expect(commands.map((command) => command.timeoutMs)).toEqual([5_000, 60_000, 60_000]);
  });

  it("shows the model the tail of a long output, and says it did", async () => {
    const { operations } = harness({
      outputMaxBytes: 16,
      exec: (input) => ({
        argv: input.argv,
        cwd: input.cwd,
        exitCode: 0,
        stdout: "0123456789".repeat(10),
        stderr: "",
        truncated: false,
        timedOut: false,
        oomKilled: false,
        durationMs: 1,
        commandId: 1,
        commandExecutionId: "exec-1",
      }),
    });

    const chunks: string[] = [];
    await operations.bash.exec("build", REPO, {
      onData: (data) => chunks.push(data.toString("utf8")),
    });

    const shown = chunks.join("");
    expect(shown).toContain("showing the last 16 bytes");
    expect(shown.endsWith("6789")).toBe(true);
  });

  it("treats a killed command as fatal, because the container went with it", async () => {
    const { operations, fatals } = harness({
      exec: (input) => ({
        argv: input.argv,
        cwd: input.cwd,
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: true,
        oomKilled: false,
        durationMs: 60_000,
        commandId: 1,
        commandExecutionId: "exec-1",
      }),
    });

    await expect(
      operations.bash.exec("sleep infinity", REPO, { onData: () => undefined }),
    ).rejects.toThrow(CommandTimedOutError);
    // Not a tool error the model can work around: there is no sandbox left.
    expect(fatals[0]).toBeInstanceOf(CommandTimedOutError);
  });

  it("reports a non-zero exit as a result, leaving the meaning to the model", async () => {
    const { operations, fatals } = harness({
      exec: (input) => ({
        argv: input.argv,
        cwd: input.cwd,
        exitCode: 1,
        stdout: "1 test failed",
        stderr: "",
        truncated: false,
        timedOut: false,
        oomKilled: false,
        durationMs: 20,
        commandId: 1,
        commandExecutionId: "exec-1",
      }),
    });

    await expect(
      operations.bash.exec("pnpm test", REPO, { onData: () => undefined }),
    ).resolves.toEqual({
      exitCode: 1,
    });
    expect(fatals).toEqual([]);
  });

  it("correlates a command with the tool call that asked for it", async () => {
    const { operations, recorded } = harness();

    await withToolCall("call-42", () =>
      operations.bash.exec("ls", REPO, { onData: () => undefined }),
    );

    expect(recorded[0]?.toolCallId).toBe("call-42");
    expect(recorded[0]?.command.commandExecutionId).toBe("exec-1");
  });

  it("still runs the command when the correlation callback throws", async () => {
    const onCommand = vi.fn(() => {
      throw new Error("the timeline is on fire");
    });
    const { operations } = harness({ onCommand });

    // A nicety on the timeline is not worth failing a tool call the model is
    // waiting on.
    await expect(operations.bash.exec("ls", REPO, { onData: () => undefined })).resolves.toEqual({
      exitCode: 0,
    });
    expect(onCommand).toHaveBeenCalled();
  });
});
