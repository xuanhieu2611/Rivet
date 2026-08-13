import {
  commandKilledError,
  DependencyInstallFailedError,
  RepoUnavailableError,
  UnsupportedProjectError,
} from "../sandbox/errors";
import { problem, splitLines } from "./command-output";
import type { PhaseContext, PhaseExecInput, RecordedCommand } from "./phase-context";
import type { PipelineOptions } from "./phases";
import { detectPackageManager, type ProjectPlan, REPO_DIRNAME } from "./project";

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

/** Container ids are 64 hex characters; nobody reads more than the first twelve. */
function shortId(id: string): string {
  return id.slice(0, 12);
}
