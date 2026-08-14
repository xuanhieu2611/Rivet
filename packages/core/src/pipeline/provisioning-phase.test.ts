import type { JobDetail } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { JobCancelledError } from "../jobs/failure";
import type { ProvisioningPatch } from "../jobs/provisioning";
import {
  CommandTimedOutError,
  DependencyInstallFailedError,
  OutOfMemoryError,
  RepoUnavailableError,
  UnsupportedProjectError,
} from "../sandbox/errors";
import type { ExecResult, Sandbox, SandboxProvider, SandboxSpec } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import type {
  PhaseContext,
  PhaseEventInput,
  PhaseExecInput,
  RecordedCommand,
} from "./phase-context";
import type { PipelineOptions } from "./phases";
import { provisioningPhase } from "./provisioning-phase";

/**
 * The phase against a hand-made context: no database, no Docker, no clock.
 *
 * That is the payoff of putting every effect on `PhaseContext` rather than
 * importing it. What is asserted here is the phase's judgment - which command,
 * in which order, and what each exit code is taken to mean - which is the part
 * that has to be right. Whether a container really starts is the `*.sbx` suite's
 * question, and it is not answerable here on purpose.
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

/** The repository the fake sandbox pretends to hold, unless a test says otherwise. */
const DEFAULT_LISTING = ".\n..\n.git\npackage.json\npnpm-lock.yaml\nsrc\n";

type Responder = (argv: string[]) => Partial<ExecResult> | undefined;

function harness(options: { respond?: Responder; createFails?: Error } = {}) {
  const holder = new SandboxHolder();
  const controller = new AbortController();
  const executed: PhaseExecInput[] = [];
  const events: PhaseEventInput[] = [];
  const patches: ProvisioningPatch[] = [];
  const specs: SandboxSpec[] = [];

  const sandbox: Sandbox = {
    id: "c0ffee0c0ffee0c0ffee",
    exec: () => Promise.reject(new Error("the phase must go through ctx.exec")),
    getFile: () => Promise.reject(new Error("provisioning reads no files")),
    putFile: () => Promise.reject(new Error("provisioning writes no files")),
    destroy: () => Promise.resolve(),
  };

  const provider: SandboxProvider = {
    create: (spec) => {
      if (options.createFails) return Promise.reject(options.createFails);
      specs.push(spec);
      return Promise.resolve(sandbox);
    },
    reap: () => Promise.resolve([]),
  };

  const pipelineOptions: PipelineOptions = { ...OPTIONS_BASE, sandbox: provider };

  const ctx: PhaseContext = {
    job: JOB,
    phase: { status: "provisioning", label: "Provision sandbox", durationMs: 0 },
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
        ...scripted,
      };
      return Promise.resolve(result);
    },

    event: (input) => {
      events.push(input);
      return Promise.resolve();
    },

    recordProvisioning: (patch) => {
      patches.push(patch);
      return Promise.resolve();
    },
  };

  return {
    run: () => provisioningPhase(pipelineOptions)(ctx),
    holder,
    controller,
    executed,
    events,
    patches,
    specs,
    sandbox,
  };
}

/** What a healthy repository answers, so a test only scripts what it cares about. */
function defaultResponse(argv: string[]): Partial<ExecResult> | undefined {
  if (argv[0] === "ls") return { stdout: DEFAULT_LISTING };
  if (argv[1] === "rev-parse") return { stdout: "9f2b0c1a4d5e6f708192a3b4c5d6e7f809112233\n" };
  if (argv[0] === "node") return { stdout: "v24.19.0\n" };
  if (argv[0] === "sha256sum") return { stdout: "abc123  pnpm-lock.yaml\n" };
  if (argv.includes("--version")) return { stdout: "10.0.0\n" };
  return undefined;
}

/** A command that was killed rather than allowed to exit. */
const KILLED = { exitCode: null, timedOut: true } satisfies Partial<ExecResult>;

describe("provisioningPhase", () => {
  it("creates the sandbox before anything that can fail", async () => {
    const test = harness({
      respond: (argv) => (argv[1] === "clone" ? { exitCode: 128 } : undefined),
    });

    await expect(test.run()).rejects.toBeInstanceOf(RepoUnavailableError);

    // The clone failed, but the container exists and the processor's `finally`
    // has to be able to find it. This is the whole reason the holder is set on
    // the line after `create` resolves.
    expect(test.holder.current).toBe(test.sandbox);
  });

  it("clones the requested branch, shallow, into the workdir", async () => {
    const test = harness();

    await test.run();

    expect(test.executed[0]?.argv).toEqual([
      "git",
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      "--single-branch",
      "https://github.com/acme/widgets",
      "/home/node/workspace/repo",
    ]);
    expect(test.executed[0]?.cwd).toBe("/home/node/workspace");
    expect(test.executed[0]?.timeoutMs).toBe(OPTIONS_BASE.cloneTimeoutMs);
  });

  it("passes the limits and an empty environment to the sandbox", async () => {
    const test = harness();

    await test.run();

    expect(test.specs[0]).toMatchObject({
      jobId: JOB.id,
      image: OPTIONS_BASE.image,
      workdir: OPTIONS_BASE.workdir,
      memoryBytes: OPTIONS_BASE.memoryBytes,
      nanoCpus: OPTIONS_BASE.nanoCpus,
      pidsLimit: OPTIONS_BASE.pidsLimit,
      // No credential of any kind reaches a container at Milestone 2, because
      // there is no mechanism by which one could.
      env: {},
    });
  });

  it("records the container, the commit and the fingerprint as each becomes true", async () => {
    const test = harness();

    await test.run();

    expect(test.patches[0]).toEqual({ sandboxId: test.sandbox.id });
    expect(test.patches[1]).toEqual({
      baseCommitSha: "9f2b0c1a4d5e6f708192a3b4c5d6e7f809112233",
    });
    expect(test.patches[2]?.envFingerprint).toMatchObject({
      image: OPTIONS_BASE.image,
      node: "v24.19.0",
      packageManager: { name: "pnpm", version: "10.0.0" },
      lockfile: "pnpm-lock.yaml",
      lockfileSha256: "abc123",
      commitSha: "9f2b0c1a4d5e6f708192a3b4c5d6e7f809112233",
      limits: {
        memoryBytes: OPTIONS_BASE.memoryBytes,
        nanoCpus: OPTIONS_BASE.nanoCpus,
        pidsLimit: OPTIONS_BASE.pidsLimit,
      },
    });
  });

  it("writes the timeline in the order the facts happened", async () => {
    const test = harness();

    await test.run();

    expect(test.events.map((event) => event.type)).toEqual([
      "sandbox.created",
      "repo.cloned",
      "deps.installed",
    ]);
    expect(test.events[0]?.data?.containerId).toBe(test.sandbox.id);
    expect(test.events[1]?.data?.commitSha).toBe("9f2b0c1a4d5e6f708192a3b4c5d6e7f809112233");
  });

  it("installs with the manager the lockfile names", async () => {
    const test = harness();

    await test.run();

    const install = test.executed.find((input) => input.argv.includes("install"));
    expect(install?.argv).toEqual(["corepack", "pnpm", "install", "--frozen-lockfile"]);
    expect(install?.cwd).toBe("/home/node/workspace/repo");
    expect(install?.timeoutMs).toBe(OPTIONS_BASE.installTimeoutMs);
    expect(install?.env).toEqual({ COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });
  });

  it("fails terminally when the clone exits non-zero", async () => {
    const test = harness({
      respond: (argv) =>
        argv[1] === "clone"
          ? { exitCode: 128, stderr: "fatal: repository not found\n" }
          : undefined,
    });

    const error = await test.run().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RepoUnavailableError);
    // The last line the tool printed, carried into `failure_reason`, so the
    // dashboard says why rather than saying "exit 128".
    expect((error as RepoUnavailableError).message).toContain("fatal: repository not found");
    expect((error as RepoUnavailableError).category).toBe("repo_unavailable");
  });

  it("blames the sandbox, not the repository, when a command is killed", async () => {
    const test = harness({ respond: (argv) => (argv[1] === "clone" ? KILLED : undefined) });

    // Same non-zero-looking outcome, entirely different fact: `command_timed_out`
    // says the clone hung, `repo_unavailable` would have said the URL was wrong.
    await expect(test.run()).rejects.toBeInstanceOf(CommandTimedOutError);
  });

  it("reports an out-of-memory kill as memory rather than as time", async () => {
    const test = harness({
      respond: (argv) =>
        argv[0] === "corepack" ? { exitCode: null, timedOut: true, oomKilled: true } : undefined,
    });

    await expect(test.run()).rejects.toBeInstanceOf(OutOfMemoryError);
  });

  it("surfaces a cancellation as a cancellation, not as a broken repository", async () => {
    const test = harness({
      respond: (argv) => {
        if (argv[1] !== "clone") return undefined;
        // What really happens on cancel: the container is killed mid-command, so
        // the command comes back looking like a failure. The abort is the fact
        // that matters and it has to win.
        test.controller.abort(new JobCancelledError("Cancelled by the user."));
        return { exitCode: null };
      },
    });

    await expect(test.run()).rejects.toBeInstanceOf(JobCancelledError);
  });

  it("refuses a repository with no package.json", async () => {
    const test = harness({
      respond: (argv) => (argv[0] === "ls" ? { stdout: ".\n..\nREADME.md\nmain.go\n" } : undefined),
    });

    await expect(test.run()).rejects.toBeInstanceOf(UnsupportedProjectError);
  });

  it("fails terminally when the install exits non-zero", async () => {
    const test = harness({
      respond: (argv) =>
        argv[0] === "corepack" && argv[2] === "install"
          ? { exitCode: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE\n" }
          : undefined,
    });

    await expect(test.run()).rejects.toBeInstanceOf(DependencyInstallFailedError);
  });

  it("does not fail a provisioned job over an unreadable fingerprint", async () => {
    const test = harness({
      respond: (argv) => (argv[0] === "sha256sum" ? { exitCode: 1 } : undefined),
    });

    await test.run();

    // Recorded as null rather than dropped: "we could not read it" and "this
    // build of Rivet did not record it" are different facts.
    expect(test.patches[2]?.envFingerprint).toMatchObject({ lockfileSha256: null });
  });

  it("propagates a create failure without setting the holder", async () => {
    const failure = new Error("no daemon");
    const test = harness({ createFails: failure });

    await expect(test.run()).rejects.toBe(failure);
    expect(test.holder.current).toBeUndefined();
    expect(test.events).toEqual([]);
  });
});
