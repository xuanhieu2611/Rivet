import {
  commandKilledError,
  DependencyInstallFailedError,
  RepoUnavailableError,
  UnsupportedProjectError,
} from "../sandbox/errors";
import type { PhaseContext, PhaseExecInput, RecordedCommand } from "./phase-context";
import type { PipelineOptions } from "./phases";

/**
 * Phase one, for real: a container, a repository in it, and its dependencies.
 *
 * The shape of every step here is the same and it is the interesting part.
 * A command runs, its transcript is recorded whatever happened, and only then
 * does this file decide what the exit code means. The sandbox has no opinion
 * about non-zero exits - the same 1 that means "the clone 404'd" here means
 * "this repository's tests were already failing" in the baseline phase - so the
 * meaning is assigned in exactly one place, next to the command that produced
 * it.
 *
 * Everything the phase needs that is not a fact about the job is closed over
 * from `PipelineOptions` when the pipeline is built, which is why this is a
 * factory rather than a function: `packages/core` reads no environment, so the
 * image and the limits have to arrive from `apps/worker` as arguments.
 */

/** Where the working tree lands, relative to the sandbox's workdir. */
export const REPO_DIRNAME = "repo";

export function provisioningPhase(options: PipelineOptions): (ctx: PhaseContext) => Promise<void> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;

  return async function provision(ctx: PhaseContext): Promise<void> {
    const sandbox = await options.sandbox.create(
      {
        jobId: ctx.job.id,
        image: options.image,
        workdir: options.workdir,
        memoryBytes: options.memoryBytes,
        nanoCpus: options.nanoCpus,
        pidsLimit: options.pidsLimit,
        env: options.env ?? {},
        labels: {},
      },
      ctx.signal,
    );
    // Before anything else, including the event that announces it. From this
    // line on the run owns something that has to be destroyed, and the holder
    // is what the processor's `finally` reads.
    ctx.sandboxes.set(sandbox);

    await ctx.event({
      type: "sandbox.created",
      message: `Sandbox ${shortId(sandbox.id)} is up.`,
      data: { containerId: sandbox.id },
    });
    await ctx.recordProvisioning({ sandboxId: sandbox.id });

    // Depth 1 because this milestone needs a working tree, not a history.
    // Milestone 6 can deepen it when something actually wants `git log`.
    const clone = await run(ctx, {
      argv: [
        "git",
        "clone",
        "--depth",
        "1",
        "--branch",
        ctx.job.baseBranch,
        "--single-branch",
        ctx.job.repoUrl,
        repoDir,
      ],
      cwd: options.workdir,
      timeoutMs: options.cloneTimeoutMs,
    });
    check(
      ctx,
      clone,
      (result) =>
        new RepoUnavailableError(
          `Could not clone ${ctx.job.repoUrl} at ${ctx.job.baseBranch}: ${problem(result)}`,
        ),
    );

    const head = await run(ctx, {
      argv: ["git", "rev-parse", "HEAD"],
      cwd: repoDir,
      timeoutMs: options.commandTimeoutMs,
    });
    check(
      ctx,
      head,
      (result) => new RepoUnavailableError(`Could not resolve HEAD: ${problem(result)}`),
    );

    const commitSha = head.stdout.trim();
    // The column that makes a run reproducible, nullable since Milestone 0 and
    // waiting for exactly this.
    await ctx.recordProvisioning({ baseCommitSha: commitSha });
    await ctx.event({
      type: "repo.cloned",
      message: `Cloned ${ctx.job.repoUrl} at ${ctx.job.baseBranch} (${commitSha.slice(0, 7)}).`,
      data: { commitSha },
    });

    const listing = await run(ctx, {
      argv: ["ls", "-1", "-a", repoDir],
      cwd: repoDir,
      timeoutMs: options.commandTimeoutMs,
    });
    check(
      ctx,
      listing,
      (result) =>
        new UnsupportedProjectError(`Could not read the repository root: ${problem(result)}`),
    );

    const project = detectPackageManager(splitLines(listing.stdout));
    if (!project) {
      throw new UnsupportedProjectError(
        `${ctx.job.repoUrl} has no package.json at its root, so it is not a Node project this ` +
          `milestone knows how to build.`,
      );
    }

    const install = await run(ctx, {
      argv: project.install,
      cwd: repoDir,
      // Its own budget, several times the ordinary one. A cold install of a
      // large repository is slow in a way that is not a symptom of anything.
      timeoutMs: options.installTimeoutMs,
      ...(project.env ? { env: project.env } : {}),
    });
    check(
      ctx,
      install,
      (result) =>
        new DependencyInstallFailedError(
          `\`${project.install.join(" ")}\` failed: ${problem(result)}`,
        ),
    );

    await ctx.recordProvisioning({
      envFingerprint: await fingerprint(ctx, options, { project, repoDir, commitSha }),
    });
    await ctx.event({
      type: "deps.installed",
      message: `Installed dependencies with ${project.name}.`,
      data: { argv: project.install, exitCode: install.exitCode, durationMs: install.durationMs },
    });
  };
}

/** The package managers this milestone can drive, in lockfile precedence order. */
export const PACKAGE_MANAGERS = ["pnpm", "yarn", "npm", "bun"] as const;
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

export interface ProjectPlan {
  name: PackageManagerName;
  /** The lockfile that decided it, or null when there was none. */
  lockfile: string | null;
  install: string[];
  /** Prints the manager's own version, for the fingerprint. */
  version: string[];
  env?: Record<string, string>;
}

/**
 * Corepack will not prompt for a download it cannot ask a human about.
 *
 * `pnpm` and `yarn` are not in the sandbox image; corepack ships with Node and
 * fetches the right one. Without this it stops on an interactive confirmation
 * inside a container with no terminal, and the symptom is an install that hangs
 * until its timeout rather than one that says what it wanted.
 */
const COREPACK_ENV = { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

/**
 * Which package manager a repository uses, decided by its lockfile.
 *
 * Lockfile-driven rather than `packageManager`-field-driven because the
 * lockfile is the thing the install command has to agree with, and a repository
 * whose field and lockfile disagree is one where the lockfile wins.
 *
 * Returns `null` for anything without a `package.json`, which is the
 * `unsupported_project` case: no lockfile at all is still a Node project and
 * still installable, but no manifest is not a project this milestone can build.
 */
export function detectPackageManager(entries: readonly string[]): ProjectPlan | null {
  const files = new Set(entries);
  if (!files.has("package.json")) return null;

  if (files.has("pnpm-lock.yaml")) {
    return {
      name: "pnpm",
      lockfile: "pnpm-lock.yaml",
      install: ["corepack", "pnpm", "install", "--frozen-lockfile"],
      version: ["corepack", "pnpm", "--version"],
      env: COREPACK_ENV,
    };
  }
  if (files.has("yarn.lock")) {
    return {
      name: "yarn",
      lockfile: "yarn.lock",
      install: ["corepack", "yarn", "install", "--immutable"],
      version: ["corepack", "yarn", "--version"],
      env: COREPACK_ENV,
    };
  }
  if (files.has("package-lock.json")) {
    return {
      name: "npm",
      lockfile: "package-lock.json",
      install: ["npm", "ci"],
      version: ["npm", "--version"],
    };
  }
  if (files.has("bun.lock") || files.has("bun.lockb")) {
    return {
      name: "bun",
      lockfile: files.has("bun.lock") ? "bun.lock" : "bun.lockb",
      install: ["bun", "install", "--frozen-lockfile"],
      version: ["bun", "--version"],
    };
  }

  // A manifest with no lockfile. `npm ci` refuses to run without one, so this
  // is the one case that installs from the manifest and accepts that two runs a
  // week apart may resolve differently - which is exactly what the fingerprint
  // is for.
  return {
    name: "npm",
    lockfile: null,
    install: ["npm", "install", "--no-audit", "--no-fund"],
    version: ["npm", "--version"],
  };
}

/**
 * What this run actually executed in, recorded because a green run nobody can
 * reproduce is a green run nobody can trust (PRD §11 B, §24.2).
 *
 * Best effort by design: every value here is read with a command that can fail,
 * and none of them are worth failing a successfully provisioned job over. A
 * missing entry is recorded as `null` rather than omitted, so the difference
 * between "we could not read it" and "this build of Rivet did not record it" is
 * visible later.
 */
async function fingerprint(
  ctx: PhaseContext,
  options: PipelineOptions,
  input: { project: ProjectPlan; repoDir: string; commitSha: string },
): Promise<Record<string, unknown>> {
  const node = await readValue(ctx, {
    argv: ["node", "--version"],
    cwd: input.repoDir,
    timeoutMs: options.commandTimeoutMs,
  });
  const packageManagerVersion = await readValue(ctx, {
    argv: input.project.version,
    cwd: input.repoDir,
    timeoutMs: options.commandTimeoutMs,
    ...(input.project.env ? { env: input.project.env } : {}),
  });
  const lockfileSha256 = input.project.lockfile
    ? await readValue(ctx, {
        argv: ["sha256sum", input.project.lockfile],
        cwd: input.repoDir,
        timeoutMs: options.commandTimeoutMs,
      }).then((value) => value?.split(/\s+/)[0] ?? null)
    : null;

  return {
    image: options.image,
    node,
    packageManager: { name: input.project.name, version: packageManagerVersion },
    lockfile: input.project.lockfile,
    lockfileSha256,
    commitSha: input.commitSha,
    repoUrl: ctx.job.repoUrl,
    baseBranch: ctx.job.baseBranch,
    limits: {
      memoryBytes: options.memoryBytes,
      nanoCpus: options.nanoCpus,
      pidsLimit: options.pidsLimit,
    },
    recordedAt: new Date().toISOString(),
  };
}

/** One command, with the phase's own defaults filled in. */
function run(ctx: PhaseContext, input: PhaseExecInput): Promise<RecordedCommand> {
  return ctx.exec(input);
}

/**
 * Turns a finished command into either nothing or the right error.
 *
 * The order is load-bearing. An aborted signal is checked first, because a
 * cancelled job kills the container mid-command and every command in a killed
 * container comes back looking like a failure - reporting that as
 * `repo_unavailable` would blame the repository for the user pressing cancel.
 * Then the sandbox's own kills, which are facts about the sandbox rather than
 * about the command. Only what is left is the caller's to interpret.
 */
function check(
  ctx: PhaseContext,
  result: RecordedCommand,
  failure: (result: RecordedCommand) => Error,
): void {
  ctx.signal.throwIfAborted();
  const killed = commandKilledError(result);
  if (killed) throw killed;
  if (result.exitCode !== 0) throw failure(result);
}

/** Runs a command whose output is wanted and whose failure is not fatal. */
async function readValue(ctx: PhaseContext, input: PhaseExecInput): Promise<string | null> {
  const result = await ctx.exec(input);
  ctx.signal.throwIfAborted();
  if (result.exitCode !== 0) {
    ctx.log.warn({ argv: input.argv, exitCode: result.exitCode }, "fingerprint command failed");
    return null;
  }
  return result.stdout.trim() || null;
}

/** The last thing the command said, which is where a tool puts its reason. */
function problem(result: RecordedCommand): string {
  const lines = [...splitLines(result.stderr), ...splitLines(result.stdout)];
  const last = lines.at(-1);
  return last ? `exit ${result.exitCode ?? "(killed)"}: ${last}` : `exit ${result.exitCode}`;
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Container ids are 64 hex characters; nobody reads more than the first twelve. */
function shortId(id: string): string {
  return id.slice(0, 12);
}
