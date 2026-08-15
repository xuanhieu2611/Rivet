import { parseSerializedBaselineReport, type JobDetail } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { JobCancelledError } from "../jobs/failure";
import { CommandTimedOutError, OutOfMemoryError, SandboxUnavailableError } from "../sandbox/errors";
import type { ExecResult, FileRead, Sandbox, SandboxProvider } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import { baselinePhase } from "./baseline-phase";
import type {
  PhaseArtifactInput,
  PhaseContext,
  PhaseEventInput,
  PhaseExecInput,
  RecordedCommand,
} from "./phase-context";
import type { PipelineOptions } from "./phases";

const JOB = {
  id: "11111111-2222-3333-4444-555555555555",
  repoUrl: "https://github.com/acme/widgets",
  baseBranch: "main",
} as unknown as JobDetail;

const OPTIONS_BASE = {
  image: "node@sha256:deadbeef",
  workdir: "/home/node/workspace",
  memoryBytes: 2_147_483_648,
  nanoCpus: 2_000_000_000,
  pidsLimit: 512,
  commandTimeoutMs: 120_000,
  cloneTimeoutMs: 180_000,
  installTimeoutMs: 300_000,
  baselineTimeoutMs: 300_000,
  checkTimeoutMs: 180_000,
  diffMaxBytes: 1_048_576,
  validationReportMaxBytes: 4_194_304,
  targetedMaxFiles: 25,
};

const REPO_DIR = "/home/node/workspace/repo";
const DEFAULT_LISTING = ".\n..\n.git\npackage.json\npnpm-lock.yaml\nsrc\n";
const DEFAULT_MANIFEST = JSON.stringify({
  name: "widgets",
  scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." },
  devDependencies: { vitest: "4.1.0" },
});
const TEST_REPORT = JSON.stringify({
  numTotalTests: 3,
  numPassedTests: 1,
  numFailedTests: 1,
  numPendingTests: 1,
  testResults: [
    {
      name: "/home/node/workspace/repo/src/widget.test.ts",
      assertionResults: [{ status: "failed", fullName: "widget rejects an invalid id" }],
    },
  ],
});

type Responder = (argv: string[]) => Partial<ExecResult> | undefined;

interface HarnessOptions {
  listing?: string;
  manifest?: string;
  repoConfig?: string;
  respond?: Responder;
  read?: () => Promise<FileRead>;
  execError?: (argv: string[]) => Error | undefined;
}

function harness(options: HarnessOptions = {}) {
  const holder = new SandboxHolder();
  const controller = new AbortController();
  const executed: PhaseExecInput[] = [];
  const events: PhaseEventInput[] = [];
  const artifacts: PhaseArtifactInput[] = [];
  const reads: { path: string; maxBytes: number }[] = [];

  const sandbox: Sandbox = {
    id: "c0ffee0c0ffee0c0ffee",
    exec: () => Promise.reject(new Error("the phase must go through ctx.exec")),
    getFile: (path, readOptions) => {
      reads.push({ path, maxBytes: readOptions.maxBytes });
      return options.read?.() ?? Promise.resolve({ content: TEST_REPORT, truncated: false });
    },
    putFile: () => Promise.reject(new Error("the baseline phase writes no files")),
    destroy: () => Promise.resolve(),
  };
  holder.set(sandbox);

  const provider: SandboxProvider = {
    create: () => Promise.reject(new Error("the baseline phase never creates a sandbox")),
    reap: () => Promise.resolve([]),
  };

  const pipelineOptions: PipelineOptions = { ...OPTIONS_BASE, sandbox: provider };
  const listing =
    options.listing ??
    (options.repoConfig === undefined ? DEFAULT_LISTING : `${DEFAULT_LISTING}rivet.json\n`);

  const ctx: PhaseContext = {
    job: JOB,
    phase: {
      status: "analyzing",
      label: "Establish test baseline",
      durationMs: 0,
      recovery: "replay",
    },
    sandboxes: holder,
    signal: controller.signal,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    exec: (input) => {
      executed.push(input);
      const executionError = options.execError?.(input.argv);
      if (executionError) return Promise.reject(executionError);
      const scripted =
        options.respond?.(input.argv) ??
        defaultResponse(input.argv, listing, options.manifest, options.repoConfig);
      const result: RecordedCommand = {
        argv: input.argv,
        cwd: input.cwd,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        oomKilled: false,
        durationMs: 5,
        commandId: executed.length,
        commandExecutionId: `exec-${executed.length}`,
        ...scripted,
      };
      return Promise.resolve(result);
    },
    event: (input) => {
      events.push(input);
      return Promise.resolve();
    },
    artifact: (input) => {
      artifacts.push(input);
      return Promise.resolve(artifacts.length);
    },
    readBaseline: () => Promise.resolve(null),
    readSummary: () => Promise.resolve(null),
    readValidation: () => Promise.resolve(null),
    recordProvisioning: () => Promise.resolve(),
    recordAgentUsage: () => Promise.resolve(),
    readLatestCheckpoint: () => Promise.resolve(null),
    captureWorkspace: () => Promise.reject(new Error("no workspace capture here")),
    checkpoint: () => Promise.reject(new Error("the phase records no checkpoint directly")),
  };

  return {
    run: () => baselinePhase(pipelineOptions)(ctx),
    controller,
    executed,
    events,
    artifacts,
    reads,
    checks: () => events.filter((event) => event.type === "baseline.check_recorded"),
    recorded: () => events.find((event) => event.type === "baseline.recorded"),
    report: () => {
      const artifact = artifacts.find((item) => item.type === "baseline_report");
      return artifact ? parseSerializedBaselineReport(artifact.content) : undefined;
    },
  };
}

function defaultResponse(
  argv: string[],
  listing: string,
  manifest = DEFAULT_MANIFEST,
  repoConfig?: string,
): Partial<ExecResult> | undefined {
  if (argv[0] === "ls") return { stdout: listing };
  if (argv[0] === "cat" && argv[1] === "package.json") return { stdout: manifest };
  if (argv[0] === "cat" && argv[1] === "rivet.json") return { stdout: repoConfig ?? "" };
  return undefined;
}

function checkCommands(test: ReturnType<typeof harness>): PhaseExecInput[] {
  return test.executed.filter((input) => input.argv.includes("run"));
}

describe("baselinePhase", () => {
  it("runs test, typecheck, and lint in that exact order with their own budgets", async () => {
    const test = harness();

    await test.run();

    const commands = checkCommands(test);
    expect(commands.map((input) => input.argv[3])).toEqual(["test", "typecheck", "lint"]);
    expect(commands.map((input) => input.timeoutMs)).toEqual([
      OPTIONS_BASE.baselineTimeoutMs,
      OPTIONS_BASE.checkTimeoutMs,
      OPTIONS_BASE.checkTimeoutMs,
    ]);
    expect(commands.every((input) => input.cwd === REPO_DIR)).toBe(true);
    expect(commands.every((input) => input.env?.COREPACK_ENABLE_DOWNLOAD_PROMPT === "0")).toBe(
      true,
    );
    expect(test.executed[2]).toEqual({
      argv: ["mkdir", "-p", "/home/node/workspace/validation"],
      cwd: "/home/node/workspace",
      timeoutMs: OPTIONS_BASE.commandTimeoutMs,
    });
    expect(test.events.map((event) => event.type)).toEqual([
      "baseline.check_recorded",
      "baseline.check_recorded",
      "baseline.check_recorded",
      "baseline.recorded",
    ]);
  });

  it("continues after every non-zero exit and records one event per check", async () => {
    const exits = { test: 1, typecheck: 2, lint: 3 } as const;
    const test = harness({
      respond: (argv) => {
        const kind = argv[3] as keyof typeof exits;
        return kind in exits ? { exitCode: exits[kind] } : undefined;
      },
    });

    await expect(test.run()).resolves.toBeUndefined();

    expect(test.checks().map((event) => event.data)).toEqual([
      expect.objectContaining({ check: "test", checkStatus: "failed", exitCode: 1 }),
      expect.objectContaining({ check: "typecheck", checkStatus: "failed", exitCode: 2 }),
      expect.objectContaining({ check: "lint", checkStatus: "failed", exitCode: 3 }),
    ]);
    expect(test.report()?.checks.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: "test", status: "failed" },
      { kind: "typecheck", status: "failed" },
      { kind: "lint", status: "failed" },
    ]);
  });

  it("uses per-check rivet.json timeouts and sources", async () => {
    const test = harness({
      manifest: JSON.stringify({ name: "widgets" }),
      repoConfig: JSON.stringify({
        validation: {
          test: { argv: ["node", "test.js"], timeoutMs: 41_000 },
          typecheck: { argv: ["node", "types.js"], timeoutMs: 42_000 },
          lint: { argv: ["node", "lint.js"], timeoutMs: 43_000 },
        },
      }),
    });

    await test.run();

    expect(test.executed.slice(-3).map(({ argv, timeoutMs }) => ({ argv, timeoutMs }))).toEqual([
      { argv: ["node", "test.js"], timeoutMs: 41_000 },
      { argv: ["node", "types.js"], timeoutMs: 42_000 },
      { argv: ["node", "lint.js"], timeoutMs: 43_000 },
    ]);
    expect(test.report()?.checks.map((check) => check.source)).toEqual([
      "rivet_json",
      "rivet_json",
      "rivet_json",
    ]);
  });

  it("records exact skip reasons and package_json source for every missing check", async () => {
    const test = harness({ manifest: JSON.stringify({ name: "widgets", scripts: {} }) });

    await test.run();

    expect(checkCommands(test)).toEqual([]);
    expect(test.report()?.checks).toEqual([
      {
        kind: "test",
        status: "skipped",
        source: "package_json",
        reason: "there is no `test` script in package.json",
      },
      {
        kind: "typecheck",
        status: "skipped",
        source: "package_json",
        reason: "there is no `typecheck` script in package.json",
      },
      {
        kind: "lint",
        status: "skipped",
        source: "package_json",
        reason: "there is no `lint` script in package.json",
      },
    ]);
    expect(test.checks().map((event) => event.message)).toEqual([
      "Baseline test skipped: there is no `test` script in package.json.",
      "Baseline typecheck skipped: there is no `typecheck` script in package.json.",
      "Baseline lint skipped: there is no `lint` script in package.json.",
    ]);
  });

  it("uses the probe reason unchanged when every check must be skipped", async () => {
    const test = harness({
      listing: "",
      respond: (argv) => (argv[0] === "ls" ? { exitCode: 2 } : undefined),
    });

    await test.run();

    expect(
      test
        .report()
        ?.checks.every((check) => check.reason === "the repository root could not be read"),
    ).toBe(true);
    expect(test.recorded()).toEqual({
      type: "baseline.recorded",
      message: "No baseline was established: the repository root could not be read.",
      data: { baseline: "skipped" },
    });
  });

  it.each([
    ["unreadable", { exitCode: 1 }, "package.json could not be read"],
    ["malformed", { stdout: "{ not json" }, "package.json is not readable as JSON"],
    ["truncated", { stdout: DEFAULT_MANIFEST, truncated: true }, "package.json could not be read"],
  ] as const)("records exact skip reasons for an %s manifest", async (_name, result, reason) => {
    const test = harness({
      respond: (argv) => (argv[1] === "package.json" ? result : undefined),
    });

    await expect(test.run()).resolves.toBeUndefined();
    expect(test.report()?.checks.every((check) => check.reason === reason)).toBe(true);
    expect(test.recorded()?.data).toEqual({ baseline: "skipped" });
  });

  it("reads the manifest with the validation probe's complete-file cap", async () => {
    const test = harness();

    await test.run();

    const manifestRead = test.executed.find((input) => input.argv[1] === "package.json");
    expect(manifestRead?.maxOutputBytes).toBeGreaterThan(65_536);
  });

  it("keeps the legacy green event shape tied only to the test check", async () => {
    const test = harness();

    await test.run();

    const testRun = test.report()?.checks[0];
    expect(test.recorded()).toEqual({
      type: "baseline.recorded",
      message: `Baseline is green: \`${testRun?.argv?.join(" ")}\` passed.`,
      data: {
        baseline: "passed",
        argv: testRun?.argv,
        exitCode: 0,
        durationMs: 5,
        commandId: 4,
      },
    });
  });

  it("keeps the legacy red event shape without failing the job", async () => {
    const test = harness({
      respond: (argv) => (argv[3] === "test" ? { exitCode: 1 } : undefined),
    });

    await expect(test.run()).resolves.toBeUndefined();

    expect(test.recorded()?.data).toEqual({
      baseline: "failed",
      argv: test.report()?.checks[0]?.argv,
      exitCode: 1,
      durationMs: 5,
      commandId: 4,
    });
  });

  it("records parsed totals in the check event and full failure names in the canonical artifact", async () => {
    const test = harness();

    await test.run();

    expect(test.checks()[0]?.data).toMatchObject({
      check: "test",
      checkStatus: "passed",
      testsTotal: 3,
      testsFailed: 1,
    });
    expect(test.report()?.checks[0]?.tests).toEqual({
      framework: "vitest",
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      failures: ["src/widget.test.ts::widget rejects an invalid id"],
      parsed: true,
    });
    expect(test.artifacts).toEqual([
      {
        type: "baseline_report",
        content: test.artifacts[0]?.content,
        requireComplete: true,
        message: "Baseline report artifact recorded.",
      },
    ]);
  });

  it("uses a separately named reporter file outside the repository under workdir/validation", async () => {
    const test = harness();

    await test.run();

    expect(test.reads).toEqual([
      {
        path: "/home/node/workspace/validation/baseline-test.json",
        maxBytes: OPTIONS_BASE.validationReportMaxBytes,
      },
    ]);
    expect(checkCommands(test)[0]?.argv).toContain(
      "/home/node/workspace/validation/baseline-test.json",
    );
    expect(test.reads[0]?.path.startsWith(`${REPO_DIR}/`)).toBe(false);
  });

  it("degrades directory setup failure to an uninstrumented test run", async () => {
    const test = harness({
      respond: (argv) => (argv[0] === "mkdir" ? { exitCode: 1, stderr: "read only" } : undefined),
    });

    await expect(test.run()).resolves.toBeUndefined();

    expect(checkCommands(test)[0]?.argv).toEqual(["corepack", "pnpm", "run", "test"]);
    expect(test.reads).toEqual([]);
    expect(test.report()?.checks[0]).not.toHaveProperty("tests");
    expect(test.recorded()?.data).toEqual({
      baseline: "passed",
      argv: ["corepack", "pnpm", "run", "test"],
      exitCode: 0,
      durationMs: 5,
      commandId: 4,
    });
  });

  it("preserves cancellation while preparing the reporter directory", async () => {
    const test = harness({
      respond: (argv) => {
        if (argv[0] !== "mkdir") return undefined;
        test.controller.abort(new JobCancelledError("Cancelled by the user."));
        return { exitCode: null };
      },
    });

    await expect(test.run()).rejects.toBeInstanceOf(JobCancelledError);
    expect(checkCommands(test)).toEqual([]);
    expect(test.events).toEqual([]);
    expect(test.artifacts).toEqual([]);
  });

  it.each([
    ["timeout", { exitCode: null, timedOut: true }, CommandTimedOutError],
    ["oom", { exitCode: null, timedOut: true, oomKilled: true }, OutOfMemoryError],
  ] as const)("raises a reporter directory setup %s", async (_name, result, ErrorType) => {
    const test = harness({
      respond: (argv) => (argv[0] === "mkdir" ? result : undefined),
    });

    await expect(test.run()).rejects.toBeInstanceOf(ErrorType);
    expect(checkCommands(test)).toEqual([]);
    expect(test.events).toEqual([]);
    expect(test.artifacts).toEqual([]);
  });

  it("propagates a sandbox execution error while preparing the reporter directory", async () => {
    const failure = new SandboxUnavailableError("Docker stopped responding.");
    const test = harness({
      execError: (argv) => (argv[0] === "mkdir" ? failure : undefined),
    });

    await expect(test.run()).rejects.toBe(failure);
    expect(checkCommands(test)).toEqual([]);
    expect(test.events).toEqual([]);
    expect(test.artifacts).toEqual([]);
  });

  it.each([
    ["timeout", { exitCode: null, timedOut: true }, CommandTimedOutError],
    ["oom", { exitCode: null, timedOut: true, oomKilled: true }, OutOfMemoryError],
  ] as const)("raises a killed %s check", async (_name, result, ErrorType) => {
    const test = harness({
      respond: (argv) => (argv[3] === "typecheck" ? result : undefined),
    });

    await expect(test.run()).rejects.toBeInstanceOf(ErrorType);
    expect(test.checks().map((event) => event.data?.check)).toEqual(["test"]);
    expect(test.recorded()).toBeUndefined();
    expect(test.artifacts).toEqual([]);
  });

  it("surfaces cancellation before interpreting the killed command", async () => {
    const test = harness({
      respond: (argv) => {
        if (argv[3] !== "test") return undefined;
        test.controller.abort(new JobCancelledError("Cancelled by the user."));
        return { exitCode: null };
      },
    });

    await expect(test.run()).rejects.toBeInstanceOf(JobCancelledError);
    expect(test.events).toEqual([]);
    expect(test.artifacts).toEqual([]);
  });
});
