import type { JobDetail, Repository } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { sha256CheckpointPatch, type JobCheckpoint } from "../checkpoints/checkpoint-store";
import type { WorkspaceSnapshot } from "../checkpoints/workspace-snapshot";
import {
  CheckpointCorruptError,
  CheckpointRestoreFailedError,
  JobCancelledError,
} from "../jobs/failure";
import type { ProvisioningPatch } from "../jobs/provisioning";
import {
  CommandTimedOutError,
  DependencyInstallFailedError,
  OutOfMemoryError,
  RepoUnavailableError,
  UnsupportedProjectError,
} from "../sandbox/errors";
import type { ExecResult, Sandbox, SandboxProvider, SandboxSpec } from "../sandbox/sandbox";
import type { GitHubClient } from "../github/github";
import type { GitHubPipelineOptions, SeedCloneRequest } from "../github/host-git";
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
  checkTimeoutMs: 180_000,
  diffMaxBytes: 1_048_576,
  validationReportMaxBytes: 4_194_304,
  targetedMaxFiles: 25,
};

/** What the branch points at today, and what the crashed attempt was cut from. */
const BRANCH_TIP = "9f2b0c1a4d5e6f708192a3b4c5d6e7f809112233";
const ORIGINAL_COMMIT = "1a2b3c4d5e6f708192a3b4c5d6e7f8091122334455";

/** The repository the fake sandbox pretends to hold, unless a test says otherwise. */
const DEFAULT_LISTING = ".\n..\n.git\npackage.json\npnpm-lock.yaml\nsrc\n";

type Responder = (argv: string[]) => Partial<ExecResult> | undefined;

interface HarnessOptions {
  respond?: Responder;
  createFails?: Error;
  job?: Partial<JobDetail>;
  github?: GitHubPipelineOptions;
  /** The durable checkpoint this claim finds, if any. */
  checkpoint?: JobCheckpoint;
  /** What reading the newest checkpoint row throws, for the corrupt-row case. */
  checkpointFails?: Error;
  /** What re-deriving the restored workspace produces. Defaults to a match. */
  verified?: WorkspaceSnapshot | Error;
  /** A job that already knows which commit it is pinned to. */
  baseCommitSha?: string;
}

function harness(options: HarnessOptions = {}) {
  const holder = new SandboxHolder();
  const controller = new AbortController();
  const executed: PhaseExecInput[] = [];
  const events: PhaseEventInput[] = [];
  const patches: ProvisioningPatch[] = [];
  const specs: SandboxSpec[] = [];
  const writes: { path: string; content: string }[] = [];
  const housekeeping: string[][] = [];
  const archives: { path: string; archive: Uint8Array }[] = [];

  const sandbox: Sandbox = {
    id: "c0ffee0c0ffee0c0ffee",
    // Only Rivet's own housekeeping goes direct; every command the job asked
    // for still has to be recorded, so it goes through `ctx.exec`.
    exec: (request) => {
      housekeeping.push(request.argv);
      return Promise.resolve({
        argv: request.argv,
        cwd: request.cwd,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        oomKilled: false,
        durationMs: 1,
      });
    },
    getFile: () => Promise.reject(new Error("provisioning reads no files")),
    putFile: (path, content) => {
      writes.push({ path, content });
      return Promise.resolve();
    },
    putArchive: (path, archive) => {
      archives.push({ path, archive });
      return Promise.resolve();
    },
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

  const pipelineOptions: PipelineOptions = {
    ...OPTIONS_BASE,
    sandbox: provider,
    ...(options.github === undefined ? {} : { github: options.github }),
  };

  const ctx: PhaseContext = {
    job: {
      ...JOB,
      ...(options.baseCommitSha ? { baseCommitSha: options.baseCommitSha } : {}),
      ...options.job,
    },
    phase: {
      status: "provisioning",
      label: "Provision sandbox",
      durationMs: 0,
      recovery: "replay",
    },
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

    artifact: () => Promise.reject(new Error("the provisioning phase records no artifacts")),

    // Nothing has established one this early; provisioning runs before `analyzing`.
    readBaseline: () => Promise.resolve(null),
    readBaselineReport: () => Promise.resolve(null),
    readSummary: () => Promise.resolve(null),
    readValidation: () => Promise.resolve(null),
    readValidationReport: () => Promise.resolve(null),

    recordProvisioning: (patch) => {
      patches.push(patch);
      return Promise.resolve();
    },
    recordAgentUsage: () => Promise.resolve(),
    readLatestCheckpoint: () =>
      options.checkpointFails
        ? Promise.reject(options.checkpointFails)
        : Promise.resolve(options.checkpoint ?? null),

    captureWorkspace: () => {
      if (options.verified instanceof Error) return Promise.reject(options.verified);
      if (options.verified) return Promise.resolve(options.verified);
      // By default the restored tree re-derives exactly what was stored, which
      // is the whole claim `checkpoint.restored` makes.
      const patch = options.checkpoint?.restorePatch ?? new Uint8Array();
      return Promise.resolve({ patch: Buffer.from(patch), stats: STATS });
    },

    checkpoint: () => Promise.reject(new Error("the provisioning phase records no checkpoints")),
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
    writes,
    archives,
    housekeeping,
    typesOf: () => events.map((event) => event.type),
    find: (type: string) => events.find((event) => event.type === type),
    ran: (predicate: (argv: string[]) => boolean) =>
      executed.find((input) => predicate(input.argv)),
  };
}

const STATS = { filesChanged: 2, insertions: 12, deletions: 3 };
const SEEDED_COMMIT = "2b3c4d5e6f708192a3b4c5d6e7f809112233445566";
const SEEDED_TREE = "3c4d5e6f708192a3b4c5d6e7f80911223344556677";
const BOUND_REPOSITORY: Repository = {
  id: 42,
  owner: "acme",
  name: "widgets",
  private: true,
  defaultBranch: "main",
};

function githubForSeed(
  seed: (input: SeedCloneRequest) => Promise<{
    archive: Uint8Array;
    commitSha: string;
    treeSha: string;
  }>,
): GitHubPipelineOptions {
  const client: GitHubClient = {
    listInstallations: () => Promise.resolve([]),
    listRepositories: () => Promise.resolve([BOUND_REPOSITORY]),
    listIssues: () => Promise.resolve([]),
    mintInstallationToken: () =>
      Promise.resolve({
        value: "sentinel-token",
        expiresAt: new Date("2026-08-15T00:00:00.000Z"),
        redact: () => "[REDACTED]",
      }),
    getRef: () => Promise.resolve(null),
    findPullRequest: () => Promise.resolve(null),
    createPullRequest: () => Promise.reject(new Error("not used")),
    updatePullRequest: () => Promise.reject(new Error("not used")),
  };

  return { client, seedClone: seed, seedMaxBytes: 8 * 1_024 * 1_024, cloneTimeoutMs: 30_000 };
}

/** A patch whose bytes, size and checksum agree, the way a stored row's do. */
function checkpointFixture(overrides: Partial<JobCheckpoint> = {}): JobCheckpoint {
  const patch = Buffer.from(
    "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n",
    "utf8",
  );

  return {
    id: 7,
    jobId: JOB.id,
    sequence: 3,
    attemptCount: 1,
    kind: "agent_turn",
    completedPhase: null,
    resumePhase: "implementing",
    agentTurn: 2,
    baseCommitSha: ORIGINAL_COMMIT,
    sandboxId: "0ldc0ntainer0ld",
    envFingerprint: {},
    state: { version: 1 },
    patchFormat: "git_binary_full_index",
    patchCompression: "gzip",
    patchSha256: sha256CheckpointPatch(patch),
    patchByteSize: patch.byteLength,
    patchCompressedBytes: 120,
    patch,
    restorePatch: patch,
    createdAt: new Date("2026-08-14T00:00:00.000Z"),
    ...overrides,
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

  it("seeds an installation-bound repository before creating a container", async () => {
    const seedInputs: SeedCloneRequest[] = [];
    const archive = Buffer.from([0, 1, 2, 255, 3]);
    const test = harness({
      job: {
        githubInstallationId: 42,
        repoOwner: "acme",
        repoName: "widgets",
        issueNumber: 7,
      },
      github: githubForSeed((input) => {
        seedInputs.push(input);
        return Promise.resolve({ archive, commitSha: SEEDED_COMMIT, treeSha: SEEDED_TREE });
      }),
      respond: (argv) =>
        argv[1] === "rev-parse" ? { stdout: `${SEEDED_COMMIT}\n` } : defaultResponse(argv),
    });

    await test.run();

    expect(seedInputs).toHaveLength(1);
    expect(seedInputs[0]).toMatchObject({
      remoteUrl: JOB.repoUrl,
      baseBranch: JOB.baseBranch,
      timeoutMs: 30_000,
      maxArchiveBytes: 8 * 1_024 * 1_024,
    });
    expect(seedInputs[0]?.token.value).toBe("sentinel-token");
    expect(test.archives).toEqual([{ path: OPTIONS_BASE.workdir, archive }]);
    expect(test.ran((argv) => argv[1] === "clone")).toBeUndefined();
    expect(test.ran((argv) => argv[1] === "fetch")).toBeUndefined();
    expect(test.patches[1]).toEqual({ baseCommitSha: SEEDED_COMMIT });
    expect(test.find("github.repository_bound")?.data).toEqual({
      installationId: 42,
      owner: "acme",
      repo: "widgets",
      private: true,
      issueNumber: 7,
    });
    expect(test.typesOf()).toEqual([
      "github.repository_bound",
      "sandbox.created",
      "repo.cloned",
      "deps.installed",
    ]);
    expect(test.specs[0]?.env).toEqual({});
  });

  it("keeps the public clone path when no installation is bound", async () => {
    const seedInputs: SeedCloneRequest[] = [];
    const test = harness({
      github: githubForSeed((input) => {
        seedInputs.push(input);
        return Promise.reject(new Error("the seed path must not run"));
      }),
    });

    await test.run();

    expect(seedInputs).toEqual([]);
    expect(test.archives).toEqual([]);
    expect(test.executed[0]?.argv[1]).toBe("clone");
  });

  it("keeps a bound public job on the clone path when GitHub is off", async () => {
    const test = harness({
      job: { githubInstallationId: 42, repoOwner: "acme", repoName: "widgets" },
    });

    await test.run();

    expect(test.archives).toEqual([]);
    expect(test.executed[0]?.argv[1]).toBe("clone");
    expect(test.typesOf()).not.toContain("github.repository_bound");
  });

  it("pins a seeded recovery to the host commit without fetching inside the container", async () => {
    const seedInputs: SeedCloneRequest[] = [];
    const test = harness({
      baseCommitSha: ORIGINAL_COMMIT,
      job: {
        githubInstallationId: 42,
        repoOwner: "acme",
        repoName: "widgets",
      },
      github: githubForSeed((input) => {
        seedInputs.push(input);
        return Promise.resolve({
          archive: Buffer.from("seed"),
          commitSha: ORIGINAL_COMMIT,
          treeSha: SEEDED_TREE,
        });
      }),
      respond: (argv) =>
        argv[1] === "rev-parse" ? { stdout: `${ORIGINAL_COMMIT}\n` } : defaultResponse(argv),
    });

    await test.run();

    expect(seedInputs[0]?.baseCommitSha).toBe(ORIGINAL_COMMIT);
    expect(test.ran((argv) => argv[1] === "fetch")).toBeUndefined();
    expect(test.ran((argv) => argv[1] === "checkout")).toBeUndefined();
  });

  it("fails a bound seed before creating a sandbox", async () => {
    const failure = new Error("host clone failed");
    const test = harness({
      job: { githubInstallationId: 42, repoOwner: "acme", repoName: "widgets" },
      github: githubForSeed(() => Promise.reject(failure)),
    });

    await expect(test.run()).rejects.toBe(failure);
    expect(test.specs).toEqual([]);
    expect(test.holder.current).toBeUndefined();
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

  it("takes the branch tip and asks for no commit when there is nothing to recover", async () => {
    const test = harness();

    await test.run();

    // The fresh path is unchanged: no fetch, no checkout, no restore.
    expect(test.ran((argv) => argv[1] === "fetch")).toBeUndefined();
    expect(test.ran((argv) => argv[1] === "checkout")).toBeUndefined();
    expect(test.writes).toEqual([]);
    expect(test.typesOf()).not.toContain("checkpoint.restored");
  });

  it("reproduces the recorded base commit on a plain retry, and blames the repository", async () => {
    const test = harness({
      baseCommitSha: ORIGINAL_COMMIT,
      respond: (argv) =>
        argv[1] === "fetch" ? { exitCode: 128, stderr: "fatal: bad object\n" } : undefined,
    });

    // No checkpoint, but the job already knows which commit it means. A branch
    // that moved between attempts must not silently change what "the base" is.
    const error = await test.run().catch((cause: unknown) => cause);

    expect(test.ran((argv) => argv[1] === "fetch")?.argv).toContain(ORIGINAL_COMMIT);
    expect(error).toBeInstanceOf(RepoUnavailableError);
  });

  it("propagates a create failure without setting the holder", async () => {
    const failure = new Error("no daemon");
    const test = harness({ createFails: failure });

    await expect(test.run()).rejects.toBe(failure);
    expect(test.holder.current).toBeUndefined();
    expect(test.events).toEqual([]);
  });
});

/**
 * Recovery: the same phase, with a checkpoint in the database.
 *
 * What is asserted is the judgment again - which commit the attempt pins itself
 * to, that the patch is applied before the install rather than after it, and
 * that nothing claims a restore until the re-derived checksum agrees. Whether
 * `git apply` really replays a binary patch is the `*.sbx` suite's question.
 */
describe("provisioningPhase, recovering from a checkpoint", () => {
  /** HEAD is the branch tip until the checkout, and the original commit after it. */
  function atOriginalCommit(): Responder {
    let revParses = 0;
    return (argv) => {
      if (argv[1] !== "rev-parse") return undefined;
      revParses += 1;
      return { stdout: `${revParses === 1 ? BRANCH_TIP : ORIGINAL_COMMIT}\n` };
    };
  }

  it("pins the original base commit rather than whatever the branch points at now", async () => {
    const test = harness({ checkpoint: checkpointFixture(), respond: atOriginalCommit() });

    await test.run();

    expect(test.ran((argv) => argv[1] === "fetch")?.argv).toEqual([
      "git",
      "fetch",
      "--depth",
      "1",
      "origin",
      ORIGINAL_COMMIT,
    ]);
    expect(test.ran((argv) => argv[1] === "checkout")?.argv).toEqual([
      "git",
      "checkout",
      "--detach",
      "FETCH_HEAD",
    ]);
    // The commit the run records is the one it is actually on, not the one the
    // clone landed on.
    expect(test.patches[1]).toEqual({ baseCommitSha: ORIGINAL_COMMIT });
    expect(test.find("repo.cloned")?.data?.commitSha).toBe(ORIGINAL_COMMIT);
  });

  it("applies the patch into the working tree before installing dependencies", async () => {
    const checkpoint = checkpointFixture();
    const test = harness({ checkpoint, respond: atOriginalCommit() });

    await test.run();

    expect(test.writes).toEqual([
      {
        path: "/home/node/workspace/rivet-checkpoint.patch",
        content: Buffer.from(checkpoint.restorePatch).toString("utf8"),
      },
    ]);

    const argvs = test.executed.map((input) => input.argv.join(" "));
    const applied = argvs.findIndex((argv) => argv.startsWith("git apply"));
    const installed = argvs.findIndex((argv) => argv.includes("install"));
    expect(applied).toBeGreaterThan(-1);
    // The order the plan cares about: an interrupted session may have changed a
    // manifest, so the install has to see the restored one.
    expect(applied).toBeLessThan(installed);
    expect(test.executed[applied]?.argv).toEqual([
      "git",
      "apply",
      "--binary",
      "/home/node/workspace/rivet-checkpoint.patch",
    ]);
    expect(test.executed[applied]?.cwd).toBe("/home/node/workspace/repo");
    // Housekeeping stays off the command log; the timeline is the job's, not
    // Rivet's bookkeeping.
    expect(test.housekeeping).toEqual([
      ["rm", "-f", "/home/node/workspace/rivet-checkpoint.patch"],
    ]);
  });

  it("states both container ids on checkpoint.restored", async () => {
    const checkpoint = checkpointFixture();
    const test = harness({ checkpoint, respond: atOriginalCommit() });

    await test.run();

    const restored = test.find("checkpoint.restored");
    expect(restored?.data).toMatchObject({
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.sequence,
      checkpointKind: "agent_turn",
      resumePhase: "implementing",
      turn: 2,
      commitSha: ORIGINAL_COMMIT,
      // The fact that proves this was reconstruction rather than reuse.
      originalSandboxId: "0ldc0ntainer0ld",
      replacementSandboxId: test.sandbox.id,
      patchSha256: checkpoint.patchSha256,
      patchByteSize: checkpoint.patchByteSize,
      filesChanged: 2,
    });
    // Restored before the environment is declared ready, and never after.
    expect(test.typesOf()).toEqual([
      "sandbox.created",
      "repo.cloned",
      "checkpoint.restored",
      "deps.installed",
    ]);
  });

  it("fails the job when the restored workspace does not match the checkpoint", async () => {
    const checkpoint = checkpointFixture();
    const test = harness({
      checkpoint,
      respond: atOriginalCommit(),
      verified: { patch: Buffer.from("diff --git a/other b/other\n", "utf8"), stats: STATS },
    });

    const error = await test.run().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CheckpointRestoreFailedError);
    expect((error as CheckpointRestoreFailedError).category).toBe("checkpoint_restore_failed");
    // Nothing may claim a restore that did not verify.
    expect(test.typesOf()).not.toContain("checkpoint.restored");
    expect(test.find("checkpoint.rejected")?.data).toMatchObject({
      checkpointSequence: checkpoint.sequence,
      failureCategory: "checkpoint_restore_failed",
    });
  });

  it("records the failing command when the patch does not apply", async () => {
    const responder = atOriginalCommit();
    const test = harness({
      checkpoint: checkpointFixture(),
      respond: (argv) =>
        argv[1] === "apply"
          ? { exitCode: 1, stderr: "error: patch does not apply\n" }
          : responder(argv),
    });

    const error = await test.run().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CheckpointRestoreFailedError);
    expect((error as CheckpointRestoreFailedError).message).toContain("patch does not apply");
    expect(test.find("checkpoint.rejected")?.data?.argv).toEqual([
      "git",
      "apply",
      "--binary",
      "/home/node/workspace/rivet-checkpoint.patch",
    ]);
  });

  it("fails the job rather than starting again when the checkpoint cannot be read", async () => {
    const test = harness({ checkpointFails: new CheckpointCorruptError("checksum mismatch") });

    const error = await test.run().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CheckpointCorruptError);
    // Read before the container, so a terminal checkpoint costs nothing.
    expect(test.specs).toEqual([]);
    expect(test.find("checkpoint.rejected")?.data).toMatchObject({
      failureCategory: "checkpoint_corrupt",
    });
  });

  it("still verifies a checkpoint whose patch is empty, without applying one", async () => {
    const checkpoint = checkpointFixture({
      kind: "phase_boundary",
      completedPhase: "planning",
      resumePhase: "implementing",
      agentTurn: null,
      patch: new Uint8Array(),
      restorePatch: new Uint8Array(),
      patchByteSize: 0,
      patchSha256: sha256CheckpointPatch(new Uint8Array()),
    });
    const test = harness({ checkpoint, respond: atOriginalCommit() });

    await test.run();

    expect(test.writes).toEqual([]);
    expect(test.ran((argv) => argv[1] === "apply")).toBeUndefined();
    expect(test.find("checkpoint.restored")?.data).toMatchObject({
      checkpointKind: "phase_boundary",
      completedPhase: "planning",
    });
  });

  it("blames the checkpoint, not the repository, when the original commit is gone", async () => {
    const responder = atOriginalCommit();
    const test = harness({
      checkpoint: checkpointFixture(),
      respond: (argv) =>
        argv[1] === "fetch"
          ? { exitCode: 128, stderr: "fatal: could not find remote ref\n" }
          : responder(argv),
    });

    const error = await test.run().catch((cause: unknown) => cause);

    // The repository is reachable; what failed is putting this job back
    // together, and the category has to say which.
    expect(error).toBeInstanceOf(CheckpointRestoreFailedError);
  });
});
