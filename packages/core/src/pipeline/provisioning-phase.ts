import { isLocalRepoUrl } from "@rivet/contracts";

import type { JobCheckpoint } from "../checkpoints/checkpoint-store";
import { sha256CheckpointPatch } from "../checkpoints/checkpoint-store";
import { GitHubNotInstalledError, GitHubPermissionDeniedError } from "../github/errors";
import type { GitHubPipelineOptions, SeedCloneResult } from "../github/host-git";
import {
  CheckpointRestoreFailedError,
  describeError as describeJobError,
  failureCategoryFor,
  LeaseLostError,
} from "../jobs/failure";
import {
  commandKilledError,
  DependencyInstallFailedError,
  RepoUnavailableError,
  UnsupportedProjectError,
} from "../sandbox/errors";
import { problem, splitLines } from "./command-output";
import type { PhaseContext, PhaseExecInput, RecordedCommand } from "./phase-context";
import type { PipelineOptions } from "./phases";
import type { PhaseDirective } from "./run-pipeline";
import { detectPackageManager, type ProjectPlan, REPO_DIRNAME } from "./project";

/**
 * Phase one, for real: a container, a repository in it, and its dependencies -
 * and, after a crash, the workspace the previous attempt had already earned.
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
 *
 * Milestone 6 splits the body into named steps and adds two of them. Every claim
 * still provisions - a recovered run has to create and verify its environment
 * before it can truthfully display `implementing` - but a claim that finds a
 * durable checkpoint now pins the *original* commit rather than whatever the
 * branch points at today, and puts the checkpointed working tree back on top of
 * it before anything else runs.
 */

/** Written outside the clone, so it can never appear in the restored diff. */
export const CHECKPOINT_PATCH_FILENAME = "rivet-checkpoint.patch";

export function provisioningPhase(
  options: PipelineOptions,
): (ctx: PhaseContext) => Promise<PhaseDirective> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;
  const patchPath = `${options.workdir}/${CHECKPOINT_PATCH_FILENAME}`;

  return async function provision(ctx: PhaseContext): Promise<PhaseDirective> {
    // Read before the container exists. A checkpoint that cannot be validated is
    // a terminal failure, and discovering that after paying for a container and
    // a clone tells nobody anything the row did not already say.
    const checkpoint = await readCheckpoint(ctx);
    const seedTarget = checkpoint?.baseCommitSha ?? ctx.job.baseCommitSha ?? undefined;
    const seeded = await seedRepository(ctx, options, {
      // The checkpoint's commit wins over the job row's: they agree today, and
      // the one the patch was cut against is the one that has to be checked out.
      ...(seedTarget === undefined ? {} : { target: seedTarget }),
    });

    await createSandbox(ctx, options);
    if (seeded) {
      await uploadSeed(ctx, options, seeded);
    } else {
      // The unauthenticated public-repository path is deliberately unchanged.
      await cloneRepository(ctx, options, repoDir);
    }
    const commitSha = await resolveBaseCommit(ctx, options, {
      repoDir,
      // The checkpoint's commit wins over the job row's: they agree today, and
      // the one the patch was cut against is the one that has to be checked out.
      target: checkpoint?.baseCommitSha ?? ctx.job.baseCommitSha ?? null,
      recovering: checkpoint !== null,
      ...(seeded === null ? {} : { seededCommitSha: seeded.commitSha }),
    });

    if (checkpoint) {
      await restoreCheckpoint(ctx, options, { checkpoint, repoDir, patchPath });
    }

    const project = await detectProject(ctx, options, repoDir);
    const install = await installDependencies(ctx, options, { project, repoDir });
    await recordEnvironment(ctx, options, { project, repoDir, commitSha, install });

    // Nothing to ask the runner for: the queue carries on. See `PhaseDirective`.
    return undefined;
  };
}

/**
 * Chooses this job's seed source, and it is the only place that choice is made.
 *
 * Three sources in a fixed order, and the ordering is the whole design. An
 * installation binding takes the authenticated host seed. Otherwise a
 * `rivet-local:` repository takes the evaluation harness's local seed.
 * Otherwise there is no seed at all and the caller runs the unauthenticated
 * in-container clone, exactly as it did before M9.
 *
 * Everything downstream reads a `SeedCloneResult` and cannot tell which branch
 * produced it, which is what keeps an evaluation job's provisioning
 * indistinguishable from a production job's.
 */
async function seedRepository(
  ctx: PhaseContext,
  options: PipelineOptions,
  input: { target?: string },
): Promise<SeedCloneResult | null> {
  const seeded = await seedFromGitHub(ctx, options, input);
  if (seeded) return seeded;
  return seedFromBenchmark(ctx, options, input);
}

/**
 * Seeds a local benchmark repository on the worker host.
 *
 * A job whose `repoUrl` uses the scheme and a worker with no local seed source
 * is a configuration error, not a repository problem, and it fails here saying
 * so. The alternative - falling through to `git clone rivet-local:fixture-pass`
 * inside the container - reports `repo_unavailable` on a Git error message
 * about an unknown transport, which blames the case for the worker's setting.
 */
async function seedFromBenchmark(
  ctx: PhaseContext,
  options: PipelineOptions,
  input: { target?: string },
): Promise<SeedCloneResult | null> {
  if (!isLocalRepoUrl(ctx.job.repoUrl)) return null;

  const local = options.localSeed;
  if (!local) {
    throw new RepoUnavailableError(
      `Job ${ctx.job.id} names the local benchmark repository ${ctx.job.repoUrl}, but this ` +
        "worker has no local seed source. Set RIVET_EVAL=on to run evaluation jobs.",
    );
  }

  return local.seed({
    repoUrl: ctx.job.repoUrl,
    baseBranch: ctx.job.baseBranch,
    ...(input.target === undefined ? {} : { baseCommitSha: input.target }),
    timeoutMs: local.cloneTimeoutMs,
    maxArchiveBytes: local.seedMaxBytes,
    signal: ctx.signal,
  });
}

/**
 * Seeds an installation-bound repository on the worker host.
 *
 * The host clone is deliberately complete before a container exists. A private
 * repository therefore fails as a GitHub/host operation rather than creating a
 * container that can never be populated, and the short-lived read token never
 * crosses the sandbox boundary.
 */
async function seedFromGitHub(
  ctx: PhaseContext,
  options: PipelineOptions,
  input: { target?: string },
): Promise<SeedCloneResult | null> {
  const binding = githubBinding(ctx);
  if (!binding) return null;

  const github = options.github;
  if (!github) {
    // `RIVET_GITHUB=off` deliberately leaves no provider in the pipeline. A
    // bound public job may still use the legacy clone path, while finalizing
    // records that publication was skipped. Production refuses that worker
    // mode, and a private repository still fails naturally at clone time.
    return null;
  }

  const repository = await findRepository(github, binding);
  await ctx.event({
    type: "github.repository_bound",
    message:
      `Bound GitHub installation ${binding.installationId} to ` +
      `${binding.repo.owner}/${binding.repo.name}.`,
    data: {
      installationId: binding.installationId,
      owner: binding.repo.owner,
      repo: binding.repo.name,
      private: repository.private,
      ...(ctx.job.issueNumber === null || ctx.job.issueNumber === undefined
        ? {}
        : { issueNumber: ctx.job.issueNumber }),
    },
  });

  const token = await github.client.mintInstallationToken(
    binding.installationId,
    binding.repo,
    "read",
  );
  return github.seedClone({
    remoteUrl: ctx.job.repoUrl,
    baseBranch: ctx.job.baseBranch,
    ...(input.target === undefined ? {} : { baseCommitSha: input.target }),
    token,
    timeoutMs: github.cloneTimeoutMs,
    maxArchiveBytes: github.seedMaxBytes,
    signal: ctx.signal,
  });
}

/** Finds the immutable repository metadata needed for the binding audit event. */
async function findRepository(
  github: GitHubPipelineOptions,
  binding: GitHubBinding,
): Promise<{ private: boolean }> {
  const repositories = await github.client.listRepositories(binding.installationId);
  const repository = repositories.find(
    (candidate) =>
      candidate.owner.toLowerCase() === binding.repo.owner.toLowerCase() &&
      candidate.name.toLowerCase() === binding.repo.name.toLowerCase(),
  );
  if (!repository) {
    throw new GitHubPermissionDeniedError(
      `GitHub installation ${binding.installationId} cannot access ` +
        `${binding.repo.owner}/${binding.repo.name}.`,
    );
  }
  return repository;
}

interface GitHubBinding {
  installationId: number;
  repo: { owner: string; name: string };
}

function githubBinding(ctx: PhaseContext): GitHubBinding | null {
  const installationId = ctx.job.githubInstallationId;
  if (installationId === null || installationId === undefined) return null;

  if (!ctx.job.repoOwner || !ctx.job.repoName) {
    throw new GitHubNotInstalledError(
      `Job ${ctx.job.id} has GitHub installation ${installationId} without a repository binding.`,
    );
  }

  return {
    installationId,
    repo: { owner: ctx.job.repoOwner, name: ctx.job.repoName },
  };
}

/** Uploads the complete archive into the existing sandbox without a command row. */
async function uploadSeed(
  ctx: PhaseContext,
  options: PipelineOptions,
  seeded: SeedCloneResult,
): Promise<void> {
  await ctx.sandboxes.require().putArchive(options.workdir, seeded.archive, ctx.signal);
}

/**
 * The container, and the holder entry that makes it the processor's to destroy.
 */
async function createSandbox(ctx: PhaseContext, options: PipelineOptions): Promise<void> {
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
}

async function cloneRepository(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
): Promise<void> {
  // Depth 1 because this milestone needs a working tree, not a history. A
  // recovered run deepens it by exactly one commit below, and only when the
  // branch has moved on since the original attempt.
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
}

/**
 * The commit this attempt actually runs against.
 *
 * A first attempt resolves whatever the branch points at and records it. Every
 * later attempt is handed that answer back and has to reproduce it, because a
 * patch is only meaningful against the tree it was cut from and a branch that
 * moved between attempts would otherwise silently change what "the base" means
 * halfway through a job. The fetch is by object name rather than by ref: the
 * commit may no longer be the tip, and on a shallow clone it may not be present
 * at all.
 */
async function resolveBaseCommit(
  ctx: PhaseContext,
  options: PipelineOptions,
  input: {
    repoDir: string;
    target: string | null;
    recovering: boolean;
    seededCommitSha?: string;
  },
): Promise<string> {
  const { repoDir, target, recovering, seededCommitSha } = input;
  const fail = (message: string, details?: { argv?: readonly string[]; stderr?: string }): Error =>
    recovering
      ? new CheckpointRestoreFailedError(message, details ?? {})
      : new RepoUnavailableError(message);

  const head = await run(ctx, {
    argv: ["git", "rev-parse", "HEAD"],
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
  });
  check(ctx, head, (result) => fail(`Could not resolve HEAD: ${problem(result)}`));

  let commitSha = head.stdout.trim();

  if (seededCommitSha !== undefined) {
    // The host seed already resolved and checked out the exact object. Fetching
    // from the archive's removed origin would both be impossible for a private
    // repository and reintroduce the credential boundary this path exists to
    // preserve.
    if (target && target !== seededCommitSha) {
      throw fail(
        `The host seed resolved to ${seededCommitSha}, not the requested base commit ${target}.`,
      );
    }
    if (commitSha !== seededCommitSha) {
      throw fail(
        `The seeded archive resolved to ${commitSha}, not the host commit ${seededCommitSha}.`,
      );
    }
    commitSha = seededCommitSha;
  } else if (target && target !== commitSha) {
    const fetch = await run(ctx, {
      argv: ["git", "fetch", "--depth", "1", "origin", target],
      cwd: repoDir,
      timeoutMs: options.cloneTimeoutMs,
    });
    check(ctx, fetch, (result) =>
      fail(
        `Could not fetch the original base commit ${target.slice(0, 7)} from ${ctx.job.repoUrl}: ` +
          `${problem(result)}`,
        { argv: result.argv, stderr: result.stderr },
      ),
    );

    const checkout = await run(ctx, {
      argv: ["git", "checkout", "--detach", "FETCH_HEAD"],
      cwd: repoDir,
      timeoutMs: options.commandTimeoutMs,
    });
    check(ctx, checkout, (result) =>
      fail(
        `Could not check out the original base commit ${target.slice(0, 7)}: ${problem(result)}`,
        {
          argv: result.argv,
          stderr: result.stderr,
        },
      ),
    );

    const restored = await run(ctx, {
      argv: ["git", "rev-parse", "HEAD"],
      cwd: repoDir,
      timeoutMs: options.commandTimeoutMs,
    });
    check(ctx, restored, (result) =>
      fail(`Could not confirm the checked-out commit: ${problem(result)}`),
    );

    commitSha = restored.stdout.trim();
    if (commitSha !== target) {
      // Asserted rather than assumed. Everything after this - the patch, the
      // baseline it will be compared against - is only true relative to this
      // commit, so being quietly on a different one is the worst outcome here.
      throw fail(`Expected to be on ${target}, but HEAD is ${commitSha}.`);
    }
  }

  // The column that makes a run reproducible, nullable since Milestone 0 and
  // waiting for exactly this.
  await ctx.recordProvisioning({ baseCommitSha: commitSha });
  await ctx.event({
    type: "repo.cloned",
    message:
      `${seededCommitSha === undefined ? "Cloned" : "Seeded"} ` +
      `${ctx.job.repoUrl} at ${ctx.job.baseBranch} (${commitSha.slice(0, 7)}).`,
    data: { commitSha },
  });

  return commitSha;
}

/**
 * Puts an acknowledged workspace back, and proves that it went back whole.
 *
 * The patch is written outside the clone and applied into the working tree
 * rather than into the index. Recovery restores file content, additions,
 * deletions, modes and binary changes; it deliberately does not restore the
 * previous session's staged-versus-unstaged distinction, because the useful
 * thing for the replacement session is an ordinary `git diff` that shows the
 * work so far.
 *
 * Verification happens here, immediately after the apply and *before* the
 * dependency install, which is a deliberate departure from the step order in
 * `docs/plans/milestone-6.md`. The check exists to prove that restoration was
 * lossless; an install that rewrites a lockfile changes the working tree for
 * reasons that have nothing to do with restoration, and letting it run first
 * would fail perfectly restored jobs with `checkpoint_restore_failed`. The
 * install still runs against the restored manifest and lockfile, which is the
 * property that ordering was there to protect.
 */
async function restoreCheckpoint(
  ctx: PhaseContext,
  options: PipelineOptions,
  input: { checkpoint: JobCheckpoint; repoDir: string; patchPath: string },
): Promise<void> {
  const { checkpoint, repoDir, patchPath } = input;
  const sandbox = ctx.sandboxes.require();

  try {
    if (checkpoint.restorePatch.byteLength > 0) {
      // Git's binary patch format is ASCII, so the bytes that came out of
      // `git diff` survive the round trip through the file port unchanged.
      try {
        await sandbox.putFile(
          patchPath,
          Buffer.from(checkpoint.restorePatch).toString("utf8"),
          ctx.signal,
        );
      } catch (cause) {
        ctx.signal.throwIfAborted();
        throw new CheckpointRestoreFailedError(
          `Could not write checkpoint ${checkpoint.sequence} into the sandbox: ` +
            `${describeJobError(cause)}`,
          {},
          { cause },
        );
      }

      const applied = await run(ctx, {
        argv: ["git", "apply", "--binary", patchPath],
        cwd: repoDir,
        timeoutMs: options.commandTimeoutMs,
      });
      check(
        ctx,
        applied,
        (result) =>
          new CheckpointRestoreFailedError(
            `Checkpoint ${checkpoint.sequence} does not apply to ${checkpoint.baseCommitSha.slice(0, 7)}: ` +
              `${problem(result)}`,
            { argv: result.argv, stderr: result.stderr },
          ),
      );

      await removePatchFile(ctx, options, patchPath);
    }

    // The proof. Re-deriving the patch with the same algorithm that captured it
    // and comparing checksums is what separates "a container exists and a
    // command exited zero" from "this workspace is the one that was
    // acknowledged".
    const verified = await ctx.captureWorkspace({ repositoryDir: repoDir });
    const sha256 = sha256CheckpointPatch(verified.patch);
    if (
      sha256 !== checkpoint.patchSha256 ||
      verified.patch.byteLength !== checkpoint.patchByteSize
    ) {
      throw new CheckpointRestoreFailedError(
        `Restored workspace does not match checkpoint ${checkpoint.sequence}: expected ` +
          `${checkpoint.patchByteSize} bytes / ${checkpoint.patchSha256}, got ` +
          `${verified.patch.byteLength} bytes / ${sha256}.`,
      );
    }

    await ctx.event({
      type: "checkpoint.restored",
      message:
        `Restored checkpoint ${checkpoint.sequence} (${checkpoint.kind}) into sandbox ` +
        `${shortId(sandbox.id)}; resuming at ${checkpoint.resumePhase}.`,
      data: {
        checkpointId: checkpoint.id,
        checkpointSequence: checkpoint.sequence,
        checkpointKind: checkpoint.kind,
        ...(checkpoint.completedPhase ? { completedPhase: checkpoint.completedPhase } : {}),
        resumePhase: checkpoint.resumePhase,
        attempt: checkpoint.attemptCount,
        ...(checkpoint.agentTurn === null ? {} : { turn: checkpoint.agentTurn }),
        commitSha: checkpoint.baseCommitSha,
        // Both ids, because this is the fact that proves recovery reconstructed
        // an environment rather than reusing one.
        originalSandboxId: checkpoint.sandboxId,
        replacementSandboxId: sandbox.id,
        sandboxId: sandbox.id,
        patchFormat: checkpoint.patchFormat,
        patchSha256: checkpoint.patchSha256,
        patchByteSize: checkpoint.patchByteSize,
        ...verified.stats,
      },
    });
  } catch (error) {
    await recordRejection(ctx, error, {
      checkpointId: checkpoint.id,
      checkpointSequence: checkpoint.sequence,
      checkpointKind: checkpoint.kind,
    });
    throw error;
  }
}

/**
 * Removes the uploaded patch, best effort and off the timeline.
 *
 * A direct sandbox call rather than `ctx.exec` for the same reason the snapshot
 * commands are: this is Rivet's own bookkeeping inside a container, not a step
 * of the job anybody asked for, and a `job_commands` row per housekeeping
 * command buys noise. The file lives outside the clone, so failing to remove it
 * cannot change a diff - the container is destroyed shortly afterwards either
 * way.
 */
async function removePatchFile(
  ctx: PhaseContext,
  options: PipelineOptions,
  patchPath: string,
): Promise<void> {
  try {
    await ctx.sandboxes.require().exec({
      argv: ["rm", "-f", patchPath],
      cwd: options.workdir,
      timeoutMs: Math.min(options.commandTimeoutMs, 5_000),
      signal: ctx.signal,
      maxOutputBytes: 1_024,
    });
  } catch (error) {
    ctx.log.warn({ err: error, patchPath }, "could not remove the uploaded checkpoint patch");
  }
}

/**
 * The newest checkpoint this job has, or nothing on a first attempt.
 *
 * A row that fails validation is raised rather than skipped: Rivet said that
 * work was safely captured, and quietly restarting from the base commit would
 * make that statement a lie. The timeline gets a `checkpoint.rejected` line
 * before the phase fails so the reason is visible next to the attempt it
 * stopped.
 */
async function readCheckpoint(ctx: PhaseContext): Promise<JobCheckpoint | null> {
  try {
    return await ctx.readLatestCheckpoint();
  } catch (error) {
    await recordRejection(ctx, error, {});
    throw error;
  }
}

/** One rejection line, and never a reason to replace the error that caused it. */
async function recordRejection(
  ctx: PhaseContext,
  error: unknown,
  data: {
    checkpointId?: number;
    checkpointSequence?: number;
    checkpointKind?: JobCheckpoint["kind"];
  },
): Promise<void> {
  if (ctx.signal.aborted) return;

  const details = error instanceof CheckpointRestoreFailedError ? error : undefined;
  try {
    await ctx.event({
      type: "checkpoint.rejected",
      message: `Checkpoint rejected: ${describeJobError(error)}`,
      data: {
        ...data,
        failureCategory: failureCategoryFor(error),
        error: describeJobError(error),
        ...(details && details.argv.length > 0 ? { argv: [...details.argv] } : {}),
        ...(details && details.stderr.length > 0 ? { stderr: details.stderr } : {}),
      },
    });
  } catch (eventError) {
    if (eventError instanceof LeaseLostError) throw eventError;
    ctx.log.warn({ err: eventError }, "could not record the rejected checkpoint");
  }
}

async function detectProject(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
): Promise<ProjectPlan> {
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

  return project;
}

/**
 * Installs from whatever manifest and lockfile the workspace now holds.
 *
 * After restoration rather than before it, and that order is the whole point: an
 * interrupted session may have changed a dependency, and installing the base
 * commit's lockfile first would reconstruct a filesystem the session never had.
 */
async function installDependencies(
  ctx: PhaseContext,
  options: PipelineOptions,
  input: { project: ProjectPlan; repoDir: string },
): Promise<RecordedCommand> {
  const { project, repoDir } = input;
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

  return install;
}

/**
 * What this run executed in, and the line that says the environment is ready.
 *
 * The fingerprint is read before the event rather than after, so the timeline's
 * closing statement about provisioning is the last thing the phase writes.
 */
async function recordEnvironment(
  ctx: PhaseContext,
  options: PipelineOptions,
  input: {
    project: ProjectPlan;
    repoDir: string;
    commitSha: string;
    install: RecordedCommand;
  },
): Promise<void> {
  await ctx.recordProvisioning({ envFingerprint: await fingerprint(ctx, options, input) });
  await ctx.event({
    type: "deps.installed",
    message: `Installed dependencies with ${input.project.name}.`,
    data: {
      argv: input.project.install,
      exitCode: input.install.exitCode,
      durationMs: input.install.durationMs,
    },
  });
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
