import type {
  EvaluationFailureCategory,
  FailureLabelSource,
  RunResult,
  ValidationOutcome,
} from "@rivet/contracts";

import type { JobCheckpoint } from "../checkpoints/checkpoint-store";
import { sha256CheckpointPatch } from "../checkpoints/checkpoint-store";
import { captureWorkspacePatch } from "../checkpoints/workspace-snapshot";
import { REPO_DIRNAME } from "../pipeline/project";
import type { ExecResult, Sandbox, SandboxProvider } from "../sandbox/sandbox";
import type { HiddenTestFile } from "./case-loader";
import {
  hiddenTestScore,
  hiddenTestsPassed,
  parseHiddenTestReport,
  type HiddenTestTotals,
} from "./hidden-test-report";
import type { LocalSeed } from "./local-seed";
import { autoFailureLabel, isErroredOutcome, type JobOutcomeFacts } from "./run-classification";

/**
 * Grading: a second container, after the job is over, that the job never saw.
 *
 * The whole value of a hidden test is that the model could not read it, could
 * not edit it, and could not satisfy it by accident. Any design that puts the
 * hidden tests inside the job's own container at any moment risks exactly that,
 * and would also put them in the diff, in the checkpoint and in the pull
 * request. So grading is its own step, owned by the runner rather than by the
 * pipeline, and it starts from the one thing a finished job leaves behind: the
 * last checkpoint's lossless binary patch against the case's immutable base
 * commit, verified by SHA-256.
 *
 * Two properties fall out of that and both are worth stating. The grader never
 * provisions anything for a job that failed before producing a workspace - that
 * run is scored from its row. And grading is **re-runnable**: the patch is in
 * Postgres and the case is in git, so a corrected hidden test can re-score
 * historical runs months later without a single model call.
 *
 * This module writes nothing. It reads a checkpoint through the callback it is
 * given and returns a value; `jobs` and `job_events` are not its to touch, and
 * a grading failure is the runner's problem rather than a second opinion about
 * a job that already finished.
 */

/** Written outside the clone, so it can never appear in the re-derived patch. */
export const GRADE_PATCH_FILENAME = "rivet-grade.patch";

/** The case as the grader needs it: what to copy in, and what to run. */
export interface GradingBenchmark {
  id: string;
  /** The URL the job ran against, re-used so the grader seeds the same source. */
  repoUrl: string;
  baseBranch: string;
  setupCommand: readonly string[] | null;
  validationCommand: readonly string[];
  hiddenFiles: readonly HiddenTestFile[];
}

/**
 * The grading container's shape, supplied by the caller in full.
 *
 * The same rule `PipelineOptions` follows, for the same reason: `packages/core`
 * holds no policy, and a default limit in the package that is supposed to have
 * none is how a container ends up unbounded. The image in particular is the
 * caller's to pass and must be the pinned digest the job itself ran on -
 * grading a tree on a different runtime is grading a different tree.
 */
export interface GradingSandboxOptions {
  provider: SandboxProvider;
  image: string;
  workdir: string;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  /** Budget for the grader's own Git housekeeping. */
  commandTimeoutMs: number;
  /** Budget for the case's setup and validation commands. */
  validationTimeoutMs: number;
  /** Cap on each recorded stdout and stderr. */
  maxOutputBytes: number;
  /** Upper bound on the re-derived patch, mirroring the checkpoint store's. */
  maxPatchBytes: number;
  labels?: Record<string, string>;
}

export interface GradeEvaluationRunInput {
  /** Only for messages and labels; the grader never writes to this job. */
  jobId: string;
  job: JobOutcomeFacts;
  /** The job's aggregate validation outcome, which a pass requires not be `regressed`. */
  validationOutcome: ValidationOutcome | null;
  benchmark: GradingBenchmark;
  /** Deliberately lazy: an errored job's checkpoint is never even read. */
  readCheckpoint: () => Promise<JobCheckpoint | null>;
  seed: LocalSeed;
  seedTimeoutMs: number;
  seedMaxBytes: number;
  sandbox: GradingSandboxOptions;
  signal: AbortSignal;
  now?: () => Date;
}

/** One command the grader ran, with its transcript already bounded. */
export interface GradedCommand {
  phase: "setup" | "validation";
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  oomKilled: boolean;
  durationMs: number;
}

export interface GradeEvaluationRunResult {
  result: RunResult;
  /** Null for `errored` and `ungraded`, which is what the run schema requires. */
  score: number | null;
  failureCategory: EvaluationFailureCategory | null;
  failureLabelSource: FailureLabelSource | null;
  hiddenTests: HiddenTestTotals | null;
  commands: GradedCommand[];
  /** The grading container, when one existed. Never the job's own sandbox. */
  sandboxId: string | null;
  gradedAt: Date;
  /** Why a run ended up errored or ungraded. For the runner's log, not the job's. */
  detail: string | null;
}

/**
 * A grading step that could not run, which is never the graded run's fault.
 *
 * Every one of these becomes `ungraded` rather than `failed`. Scoring a
 * solution zero because the harness could not set up is the same category of
 * lie as scoring a tree the job did not produce, and both are worse than
 * reporting no number at all.
 */
class GradingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GradingError";
  }
}

/**
 * Grades one finished job against its benchmark case.
 *
 * The order is the contract, and it is the order the acceptance document
 * fixes: classify from the job row first, then decide whether grading can run,
 * then pass or fail. A job that failed in `provisioning` is `errored` and never
 * reaches the second question, which is also why it costs no container -
 * infrastructure failures arrive in bursts, and a grader that provisions to
 * discover there is nothing to grade pays for every one of them.
 */
export async function gradeEvaluationRun(
  input: GradeEvaluationRunInput,
): Promise<GradeEvaluationRunResult> {
  const gradedAt = (input.now ?? (() => new Date()))();
  const commands: GradedCommand[] = [];

  if (isErroredOutcome(input.job)) {
    const label = autoFailureLabel(input.job, "errored");
    return {
      result: "errored",
      score: null,
      failureCategory: label?.label ?? null,
      failureLabelSource: label?.source ?? null,
      hiddenTests: null,
      commands,
      sandboxId: null,
      gradedAt,
      detail:
        `Job ${input.jobId} ended ${input.job.status}` +
        `${input.job.failureCategory ? ` (${input.job.failureCategory})` : ""}, ` +
        "which is an infrastructure outcome rather than a task outcome.",
    };
  }

  let sandbox: Sandbox | null = null;
  try {
    const checkpoint = await readGradableCheckpoint(input);
    const seeded = await seedGradingWorkspace(input, checkpoint);

    sandbox = await createGradingSandbox(input);
    const repoDir = `${input.sandbox.workdir}/${REPO_DIRNAME}`;
    await uploadSeed(input, sandbox, seeded.archive);
    await restoreWorkspace(input, sandbox, checkpoint, repoDir);
    await installHiddenTests(input, sandbox, repoDir);

    const setup = await runCaseCommand(input, sandbox, repoDir, "setup");
    if (setup) {
      commands.push(setup);
      if (setup.exitCode !== 0) {
        throw new GradingError(
          `The case's setup command exited ${String(setup.exitCode)}; the grading environment ` +
            "could not be prepared.",
        );
      }
    }

    const validation = await runCaseCommand(input, sandbox, repoDir, "validation");
    if (!validation) {
      throw new GradingError("The case has no validation command.");
    }
    commands.push(validation);

    const hiddenTests = parseHiddenTestReport(validation);
    const passedHidden = hiddenTestsPassed(validation, hiddenTests);
    const result: RunResult =
      input.job.status === "completed" && passedHidden && input.validationOutcome !== "regressed"
        ? "passed"
        : "failed";
    const label = autoFailureLabel(input.job, result);

    return {
      result,
      score: hiddenTestScore(hiddenTests),
      failureCategory: label?.label ?? null,
      failureLabelSource: label?.source ?? null,
      hiddenTests,
      commands,
      sandboxId: sandbox.id,
      gradedAt,
      detail: null,
    };
  } catch (error) {
    // Cancellation is not a grading verdict. Everything else is: a suite where
    // one broken grade aborts the matrix is a suite nobody finishes.
    input.signal.throwIfAborted();
    if (isAbortError(error)) throw error;

    return {
      result: "ungraded",
      score: null,
      failureCategory: "grade_workspace_invalid",
      failureLabelSource: "auto",
      hiddenTests: null,
      commands,
      sandboxId: sandbox?.id ?? null,
      gradedAt,
      detail: describeError(error),
    };
  } finally {
    // The same rule the processor follows, on every exit path including the
    // throwing one. `destroy()` never throws by contract; the reaper is the
    // backstop for whatever an implementation could not remove.
    if (sandbox) await sandbox.destroy();
  }
}

/**
 * The workspace to grade, or a stated reason there is none.
 *
 * A gradable job with no checkpoint is a harness anomaly rather than a task
 * failure: every phase boundary captures one, so a job that reached a task
 * outcome without capturing anything means the capture path is broken. That is
 * `ungraded` by the same logic as a tampered patch.
 */
async function readGradableCheckpoint(input: GradeEvaluationRunInput): Promise<JobCheckpoint> {
  let checkpoint: JobCheckpoint | null;
  try {
    checkpoint = await input.readCheckpoint();
  } catch (error) {
    throw new GradingError(`Could not read the job's last checkpoint: ${describeError(error)}.`, {
      cause: error,
    });
  }

  if (!checkpoint) {
    throw new GradingError(
      `Job ${input.jobId} reached a gradable outcome without capturing a workspace.`,
    );
  }
  return checkpoint;
}

/**
 * Seeds the case at the exact commit the patch was cut against.
 *
 * The commit comparison is not ceremony. It is the check that notices a grader
 * pointed at the wrong case: a patch cut against one benchmark's base commit
 * will often apply cleanly to another's, and the difference would then show up
 * only as a mysteriously low score.
 */
async function seedGradingWorkspace(
  input: GradeEvaluationRunInput,
  checkpoint: JobCheckpoint,
): Promise<{ archive: Uint8Array }> {
  let seeded;
  try {
    seeded = await input.seed({
      repoUrl: input.benchmark.repoUrl,
      baseBranch: input.benchmark.baseBranch,
      baseCommitSha: checkpoint.baseCommitSha,
      timeoutMs: input.seedTimeoutMs,
      maxArchiveBytes: input.seedMaxBytes,
      signal: input.signal,
    });
  } catch (error) {
    throw new GradingError(
      `Could not seed ${input.benchmark.repoUrl} for grading: ${describeError(error)}.`,
      { cause: error },
    );
  }

  if (seeded.commitSha !== checkpoint.baseCommitSha) {
    throw new GradingError(
      `Grading seed for ${input.benchmark.id} resolved to ${seeded.commitSha}, not the ` +
        `checkpoint's base commit ${checkpoint.baseCommitSha}.`,
    );
  }
  return seeded;
}

async function createGradingSandbox(input: GradeEvaluationRunInput): Promise<Sandbox> {
  try {
    return await input.sandbox.provider.create(
      {
        jobId: input.jobId,
        image: input.sandbox.image,
        workdir: input.sandbox.workdir,
        memoryBytes: input.sandbox.memoryBytes,
        nanoCpus: input.sandbox.nanoCpus,
        pidsLimit: input.sandbox.pidsLimit,
        // Empty, like every other sandbox in this system, and here it is not
        // even a decision worth arguing about: the grader has no credential to
        // withhold.
        env: {},
        labels: input.sandbox.labels ?? {},
      },
      input.signal,
    );
  } catch (error) {
    throw new GradingError(`Could not create a grading sandbox: ${describeError(error)}.`, {
      cause: error,
    });
  }
}

async function uploadSeed(
  input: GradeEvaluationRunInput,
  sandbox: Sandbox,
  archive: Uint8Array,
): Promise<void> {
  try {
    await sandbox.putArchive(input.sandbox.workdir, archive, input.signal);
  } catch (error) {
    throw new GradingError(`Could not upload the grading seed: ${describeError(error)}.`, {
      cause: error,
    });
  }
}

/**
 * Puts the job's tree back, and proves it went back whole.
 *
 * The same apply-then-re-derive-then-compare shape recovery uses, and for a
 * stronger reason: recovery is trying not to lose work, while grading is
 * producing a number somebody will quote. A mismatch here is `ungraded`,
 * because grading a tree that is not the tree the job produced is worse than
 * not grading.
 */
async function restoreWorkspace(
  input: GradeEvaluationRunInput,
  sandbox: Sandbox,
  checkpoint: JobCheckpoint,
  repoDir: string,
): Promise<void> {
  const patchPath = `${input.sandbox.workdir}/${GRADE_PATCH_FILENAME}`;

  if (checkpoint.restorePatch.byteLength > 0) {
    try {
      // Git's binary patch format is ASCII, so the bytes survive the round trip
      // through the text file port unchanged.
      await sandbox.putFile(
        patchPath,
        Buffer.from(checkpoint.restorePatch).toString("utf8"),
        input.signal,
      );
    } catch (error) {
      throw new GradingError(`Could not write the checkpoint patch: ${describeError(error)}.`, {
        cause: error,
      });
    }

    const applied = await housekeeping(input, sandbox, ["git", "apply", "--binary", patchPath], {
      cwd: repoDir,
    });
    if (applied.exitCode !== 0) {
      throw new GradingError(
        `Checkpoint ${checkpoint.sequence} does not apply to ` +
          `${checkpoint.baseCommitSha.slice(0, 7)}: ${firstLine(applied.stderr)}`,
      );
    }

    await housekeeping(input, sandbox, ["rm", "-f", patchPath], {
      cwd: input.sandbox.workdir,
    });
  }

  let verified;
  try {
    verified = await captureWorkspacePatch({
      sandbox,
      repositoryDir: repoDir,
      signal: input.signal,
      timeoutMs: input.sandbox.commandTimeoutMs,
      maxBytes: input.sandbox.maxPatchBytes,
    });
  } catch (error) {
    throw new GradingError(`Could not re-derive the graded workspace: ${describeError(error)}.`, {
      cause: error,
    });
  }

  const sha256 = sha256CheckpointPatch(verified.patch);
  if (sha256 !== checkpoint.patchSha256 || verified.patch.byteLength !== checkpoint.patchByteSize) {
    throw new GradingError(
      `The graded workspace does not match checkpoint ${checkpoint.sequence}: expected ` +
        `${checkpoint.patchByteSize} bytes / ${checkpoint.patchSha256}, got ` +
        `${verified.patch.byteLength} bytes / ${sha256}.`,
    );
  }
}

/**
 * Copies `hidden/` in, after the checksum and never before it.
 *
 * The directory is removed first rather than merged into. Overwriting the
 * paths the case owns is the stated rule, but a session that invented an extra
 * file under `hidden/` would otherwise have it collected by a validation
 * command that names the directory - which is a model writing its own
 * benchmark, and it would pass.
 */
async function installHiddenTests(
  input: GradeEvaluationRunInput,
  sandbox: Sandbox,
  repoDir: string,
): Promise<void> {
  const hiddenDir = `${repoDir}/hidden`;
  const removed = await housekeeping(input, sandbox, ["rm", "-rf", hiddenDir], { cwd: repoDir });
  if (removed.exitCode !== 0) {
    throw new GradingError(`Could not clear ${hiddenDir}: ${firstLine(removed.stderr)}`);
  }

  for (const file of input.benchmark.hiddenFiles) {
    const path = `${hiddenDir}/${file.path}`;
    try {
      await sandbox.putFile(path, file.content, input.signal);
    } catch (error) {
      throw new GradingError(
        `Could not install hidden test ${file.path}: ${describeError(error)}.`,
        {
          cause: error,
        },
      );
    }
    if (file.executable) {
      const mode = await housekeeping(input, sandbox, ["chmod", "0755", path], { cwd: repoDir });
      if (mode.exitCode !== 0) {
        throw new GradingError(`Could not make ${file.path} executable.`);
      }
    }
  }
}

/** Runs one of the case's own commands and records its bounded transcript. */
async function runCaseCommand(
  input: GradeEvaluationRunInput,
  sandbox: Sandbox,
  repoDir: string,
  phase: "setup" | "validation",
): Promise<GradedCommand | null> {
  const argv = phase === "setup" ? input.benchmark.setupCommand : input.benchmark.validationCommand;
  if (!argv || argv.length === 0) return null;

  let result: ExecResult;
  try {
    result = await sandbox.exec({
      argv: [...argv],
      cwd: repoDir,
      timeoutMs: input.sandbox.validationTimeoutMs,
      signal: input.signal,
      maxOutputBytes: input.sandbox.maxOutputBytes,
    });
  } catch (error) {
    throw new GradingError(`Could not run the case's ${phase} command: ${describeError(error)}.`, {
      cause: error,
    });
  }

  // A killed command is a statement about the grading sandbox rather than
  // about the solution, the same distinction the baseline phase draws.
  if (result.timedOut || result.oomKilled) {
    throw new GradingError(
      `The case's ${phase} command was killed before it completed: ` +
        `${result.oomKilled ? "the grading sandbox ran out of memory" : "it exceeded its timeout"}.`,
    );
  }

  return {
    phase,
    argv: [...argv],
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    timedOut: result.timedOut,
    oomKilled: result.oomKilled,
    durationMs: result.durationMs,
  };
}

/**
 * Rivet's own bookkeeping inside the grading container.
 *
 * Never recorded anywhere. There is no job to attribute these to - the job is
 * over - and the grading container is not part of any timeline.
 */
async function housekeeping(
  input: GradeEvaluationRunInput,
  sandbox: Sandbox,
  argv: string[],
  options: { cwd: string },
): Promise<ExecResult> {
  try {
    return await sandbox.exec({
      argv,
      cwd: options.cwd,
      timeoutMs: input.sandbox.commandTimeoutMs,
      signal: input.signal,
      maxOutputBytes: input.sandbox.maxOutputBytes,
    });
  } catch (error) {
    throw new GradingError(
      `Could not run \`${argv.join(" ")}\` in the grading sandbox: ${describeError(error)}.`,
      { cause: error },
    );
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? "no stderr";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
