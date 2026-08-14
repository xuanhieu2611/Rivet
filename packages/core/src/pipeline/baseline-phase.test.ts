import type { JobDetail } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { JobCancelledError } from "../jobs/failure";
import { CommandTimedOutError, OutOfMemoryError } from "../sandbox/errors";
import type { ExecResult, Sandbox, SandboxProvider } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import { baselinePhase } from "./baseline-phase";
import type {
  PhaseContext,
  PhaseEventInput,
  PhaseExecInput,
  RecordedCommand,
} from "./phase-context";
import type { PipelineOptions } from "./phases";

/**
 * The phase against a hand-made context: no database, no Docker, no clock.
 *
 * Almost every test here is a variation on one claim, and it is the claim the
 * milestone would be wrong without: **a red baseline is not a failed job.** The
 * exceptions are the two kills, which are facts about the sandbox rather than
 * about the repository, and they are the only things in this file that throw.
 */

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
};

const REPO_DIR = "/home/node/workspace/repo";

/** A pnpm project with a test script, unless a test says otherwise. */
const DEFAULT_LISTING = ".\n..\n.git\npackage.json\npnpm-lock.yaml\nsrc\n";
const DEFAULT_MANIFEST = JSON.stringify({
  name: "widgets",
  scripts: { build: "tsc", test: "vitest run" },
});

type Responder = (argv: string[]) => Partial<ExecResult> | undefined;

function harness(options: { respond?: Responder } = {}) {
  const holder = new SandboxHolder();
  const controller = new AbortController();
  const executed: PhaseExecInput[] = [];
  const events: PhaseEventInput[] = [];

  const sandbox: Sandbox = {
    id: "c0ffee0c0ffee0c0ffee",
    exec: () => Promise.reject(new Error("the phase must go through ctx.exec")),
    getFile: () => Promise.reject(new Error("the baseline phase reads no files")),
    putFile: () => Promise.reject(new Error("the baseline phase writes no files")),
    destroy: () => Promise.resolve(),
  };
  holder.set(sandbox);

  const provider: SandboxProvider = {
    create: () => Promise.reject(new Error("the baseline phase never creates a sandbox")),
    reap: () => Promise.resolve([]),
  };

  const pipelineOptions: PipelineOptions = { ...OPTIONS_BASE, sandbox: provider };

  const ctx: PhaseContext = {
    job: JOB,
    phase: { status: "testing", label: "Run tests", durationMs: 0 },
    sandboxes: holder,
    signal: controller.signal,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },

    exec: (input) => {
      executed.push(input);
      const scripted = options.respond?.(input.argv) ?? defaultResponse(input.argv);
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

    artifact: () => Promise.reject(new Error("the baseline phase records no artifacts")),

    recordProvisioning: () => Promise.resolve(),
    recordAgentUsage: () => Promise.resolve(),
  };

  return {
    run: () => baselinePhase(pipelineOptions)(ctx),
    controller,
    executed,
    events,
    /** The one `baseline.recorded` every path is supposed to write. */
    recorded: () => events.find((event) => event.type === "baseline.recorded"),
  };
}

function defaultResponse(argv: string[]): Partial<ExecResult> | undefined {
  if (argv[0] === "ls") return { stdout: DEFAULT_LISTING };
  if (argv[0] === "cat") return { stdout: DEFAULT_MANIFEST };
  return undefined;
}

/** A manifest whose `scripts` block is missing the one thing this phase wants. */
const NO_TEST_SCRIPT = JSON.stringify({ name: "widgets", scripts: { build: "tsc" } });

describe("baselinePhase", () => {
  it("runs the test script through the manager the lockfile named", async () => {
    const test = harness();

    await test.run();

    const suite = test.executed.at(-1);
    expect(suite?.argv).toEqual(["corepack", "pnpm", "run", "test"]);
    expect(suite?.cwd).toBe(REPO_DIR);
    // Its own budget, not the ordinary per-command one: a four-minute suite is
    // a slow repository, not a hung sandbox.
    expect(suite?.timeoutMs).toBe(OPTIONS_BASE.baselineTimeoutMs);
    expect(suite?.env).toEqual({ COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });
  });

  it("records a green baseline", async () => {
    const test = harness();

    await test.run();

    expect(test.recorded()?.data).toMatchObject({ baseline: "passed", exitCode: 0 });
  });

  it("records a red baseline and does NOT fail the job", async () => {
    // The whole point of the phase. PRD §11 C: establish whether the repository
    // is already healthy before modifying anything, and never attribute a
    // pre-existing failure to the agent. Failing here would make Rivet unable
    // to work on exactly the repositories it is most useful for.
    const test = harness({
      respond: (argv) =>
        argv.includes("run") ? { exitCode: 1, stdout: "2 failed | 7 passed\n" } : undefined,
    });

    await expect(test.run()).resolves.toBeUndefined();

    expect(test.recorded()?.data).toMatchObject({ baseline: "failed", exitCode: 1 });
    expect(test.recorded()?.message).toContain("2 failed | 7 passed");
  });

  it("records that there was nothing to run when there is no test script", async () => {
    const test = harness({
      respond: (argv) => (argv[0] === "cat" ? { stdout: NO_TEST_SCRIPT } : undefined),
    });

    await test.run();

    expect(test.recorded()?.data).toMatchObject({ baseline: "skipped" });
    // A repository with no tests is not a broken job, and no command was run
    // for one that does not exist.
    expect(test.executed.some((input) => input.argv.includes("run"))).toBe(false);
  });

  it("skips rather than fails when the manifest cannot be read", async () => {
    const test = harness({ respond: (argv) => (argv[0] === "cat" ? { exitCode: 1 } : undefined) });

    await expect(test.run()).resolves.toBeUndefined();
    expect(test.recorded()?.data).toMatchObject({ baseline: "skipped" });
  });

  it("skips rather than fails when the manifest is not JSON", async () => {
    const test = harness({
      respond: (argv) => (argv[0] === "cat" ? { stdout: "{ not json" } : undefined),
    });

    await expect(test.run()).resolves.toBeUndefined();
    expect(test.recorded()?.data).toMatchObject({ baseline: "skipped" });
  });

  it("skips rather than trusting a manifest that was truncated", async () => {
    // A `package.json` clipped at the output cap is not a smaller manifest, it
    // is invalid JSON - and one that happened to still parse would be worse.
    const test = harness({
      respond: (argv) =>
        argv[0] === "cat" ? { stdout: DEFAULT_MANIFEST, truncated: true } : undefined,
    });

    await test.run();

    expect(test.recorded()?.data).toMatchObject({ baseline: "skipped" });
  });

  it("reads the manifest with a cap well above the default", async () => {
    const test = harness();

    await test.run();

    const cat = test.executed.find((input) => input.argv[0] === "cat");
    expect(cat?.maxOutputBytes).toBeGreaterThan(65_536);
  });

  it("fails the job when the suite outlives its timeout", async () => {
    // Not a fact about the repository. `command_timed_out` says the sandbox
    // stopped a command; a red baseline says the repository was already red.
    const test = harness({
      respond: (argv) => (argv.includes("run") ? { exitCode: null, timedOut: true } : undefined),
    });

    await expect(test.run()).rejects.toBeInstanceOf(CommandTimedOutError);
  });

  it("fails the job when the container runs out of memory", async () => {
    const test = harness({
      respond: (argv) =>
        argv.includes("run") ? { exitCode: null, timedOut: true, oomKilled: true } : undefined,
    });

    await expect(test.run()).rejects.toBeInstanceOf(OutOfMemoryError);
  });

  it("surfaces a cancellation as a cancellation, not as a red baseline", async () => {
    const test = harness({
      respond: (argv) => {
        if (!argv.includes("run")) return undefined;
        // What really happens on cancel: the container is killed mid-command, so
        // the suite comes back looking like it failed. The abort has to win, or
        // a cancelled job would leave a recorded baseline that never ran.
        test.controller.abort(new JobCancelledError("Cancelled by the user."));
        return { exitCode: null };
      },
    });

    await expect(test.run()).rejects.toBeInstanceOf(JobCancelledError);
    expect(test.recorded()).toBeUndefined();
  });

  it("skips when the repository root cannot be listed", async () => {
    const test = harness({ respond: (argv) => (argv[0] === "ls" ? { exitCode: 2 } : undefined) });

    await expect(test.run()).resolves.toBeUndefined();
    expect(test.recorded()?.data).toMatchObject({ baseline: "skipped" });
  });
});
