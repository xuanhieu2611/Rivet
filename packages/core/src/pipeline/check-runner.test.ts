import type { JobDetail } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { JobCancelledError } from "../jobs/failure";
import { CommandTimedOutError } from "../sandbox/errors";
import type { FileRead, Sandbox } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import { runCheck } from "./check-runner";
import type { PhaseContext, PhaseExecInput, RecordedCommand } from "./phase-context";

const REPORT = JSON.stringify({
  numTotalTests: 2,
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 0,
  testResults: [
    {
      name: "/home/node/workspace/repo/src/widget.test.ts",
      assertionResults: [{ status: "failed", fullName: "widget rejects an invalid id" }],
    },
  ],
});

interface HarnessOptions {
  result?: Partial<RecordedCommand>;
  read?: () => Promise<FileRead>;
}

function harness(options: HarnessOptions = {}) {
  const holder = new SandboxHolder();
  const controller = new AbortController();
  const executed: PhaseExecInput[] = [];
  const reads: { path: string; maxBytes: number }[] = [];
  let eventCalls = 0;

  const sandbox: Sandbox = {
    id: "check-runner",
    exec: () => Promise.reject(new Error("runCheck must execute through PhaseContext.exec")),
    getFile: (path, readOptions) => {
      reads.push({ path, maxBytes: readOptions.maxBytes });
      return options.read?.() ?? Promise.resolve({ content: REPORT, truncated: false });
    },
    putFile: () => Promise.reject(new Error("runCheck never writes files")),
    destroy: () => Promise.resolve(),
  };
  holder.set(sandbox);

  const ctx = {
    job: { id: "11111111-2222-3333-4444-555555555555" } as JobDetail,
    phase: { status: "testing", label: "Validate change", durationMs: 0, recovery: "replay" },
    sandboxes: holder,
    signal: controller.signal,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    exec: (input: PhaseExecInput) => {
      executed.push(input);
      return Promise.resolve({
        argv: input.argv,
        cwd: input.cwd,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        truncated: false,
        timedOut: false,
        oomKilled: false,
        durationMs: 17,
        commandId: 41,
        commandExecutionId: "command-execution-id",
        ...options.result,
      });
    },
    event: () => {
      eventCalls += 1;
      return Promise.resolve();
    },
  } as unknown as PhaseContext;

  return { ctx, controller, executed, reads, eventCalls: () => eventCalls };
}

const BASE_INPUT = {
  kind: "test" as const,
  source: "package_json" as const,
  argv: ["pnpm", "test"],
  cwd: "/home/node/workspace/repo",
  timeoutMs: 300_000,
};

describe("runCheck", () => {
  it("executes through the phase context and preserves command correlation", async () => {
    const run = harness({ result: { exitCode: 2, durationMs: 23, commandId: 73 } });

    await expect(runCheck(run.ctx, BASE_INPUT)).resolves.toEqual({
      kind: "test",
      status: "failed",
      source: "package_json",
      argv: ["pnpm", "test"],
      exitCode: 2,
      durationMs: 23,
      commandId: 73,
    });
    expect(run.executed).toEqual([
      { argv: ["pnpm", "test"], cwd: BASE_INPUT.cwd, timeoutMs: 300_000 },
    ]);
    // Check-specific events belong to Stages 6 and 7. The command lifecycle is
    // preserved by leaving execution entirely with ctx.exec.
    expect(run.eventCalls()).toBe(0);
  });

  it.each(["vitest", "jest"] as const)(
    "appends the %s reporter, reads it under its own cap, and dispatches its parser",
    async (framework) => {
      const run = harness();
      const outputPath = `/home/node/workspace/validation/${framework}.json`;

      const check = await runCheck(run.ctx, {
        ...BASE_INPUT,
        source: "rivet_json",
        env: { CI: "1" },
        reporter: { framework, outputPath, readMaxBytes: 4_194_304 },
      });

      expect(run.executed[0]).toEqual({
        argv: [
          "pnpm",
          "test",
          framework === "vitest" ? "--reporter=json" : "--json",
          "--outputFile",
          outputPath,
        ],
        cwd: BASE_INPUT.cwd,
        timeoutMs: 300_000,
        env: { CI: "1" },
      });
      expect(outputPath.startsWith(`${BASE_INPUT.cwd}/`)).toBe(false);
      expect(run.reads).toEqual([{ path: outputPath, maxBytes: 4_194_304 }]);
      expect(check.tests).toMatchObject({
        framework,
        parsed: true,
        total: 2,
        failed: 1,
        failures: ["src/widget.test.ts::widget rejects an invalid id"],
      });
    },
  );

  it("honours a declared reporter output argument", async () => {
    const run = harness();
    await runCheck(run.ctx, {
      ...BASE_INPUT,
      reporter: {
        framework: "vitest",
        outputArg: "--report-file",
        outputPath: "/home/node/workspace/validation/report.json",
        readMaxBytes: 8_192,
      },
    });

    expect(run.executed[0]?.argv).toContain("--report-file");
  });

  it("omits tests when reporter arguments are unavailable without changing status", async () => {
    const run = harness();
    const check = await runCheck(run.ctx, {
      ...BASE_INPUT,
      reporter: { framework: "vitest", outputPath: "bad\0path", readMaxBytes: 4_096 },
    });

    expect(check.status).toBe("passed");
    expect(check.tests).toBeUndefined();
    expect(run.executed[0]?.argv).toEqual(BASE_INPUT.argv);
    expect(run.reads).toEqual([]);
  });

  it("does not let reporter instrumentation write inside the repository", async () => {
    const run = harness();
    const check = await runCheck(run.ctx, {
      ...BASE_INPUT,
      reporter: {
        framework: "vitest",
        outputPath: `${BASE_INPUT.cwd}/report.json`,
        readMaxBytes: 4_096,
      },
    });

    expect(check.status).toBe("passed");
    expect(check.tests).toBeUndefined();
    expect(run.executed[0]?.argv).toEqual(BASE_INPUT.argv);
    expect(run.reads).toEqual([]);
  });

  it.each([
    ["unreadable", () => Promise.reject(new Error("missing"))],
    ["truncated", () => Promise.resolve({ content: REPORT.slice(0, 20), truncated: true })],
    ["malformed", () => Promise.resolve({ content: "{", truncated: false })],
  ] as const)("degrades %s reporter output without changing status", async (_name, read) => {
    const run = harness({ result: { exitCode: 9 }, read });
    const check = await runCheck(run.ctx, {
      ...BASE_INPUT,
      reporter: {
        framework: "jest",
        outputPath: "/home/node/workspace/validation/report.json",
        readMaxBytes: 4_096,
      },
    });

    expect(check.status).toBe("failed");
    expect(check.exitCode).toBe(9);
    expect(check.tests).toBeUndefined();
  });

  it("raises cancellation before interpreting a killed command", async () => {
    const run = harness({ result: { exitCode: null, timedOut: true } });
    const cancelled = new JobCancelledError("cancelled while checking");
    run.controller.abort(cancelled);

    await expect(runCheck(run.ctx, BASE_INPUT)).rejects.toBe(cancelled);
  });

  it("raises a command kill when the job was not aborted", async () => {
    const run = harness({ result: { exitCode: null, timedOut: true } });
    await expect(runCheck(run.ctx, BASE_INPUT)).rejects.toBeInstanceOf(CommandTimedOutError);
  });
});
