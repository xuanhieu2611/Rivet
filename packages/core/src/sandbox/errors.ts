import type { FailureCategory } from "@rivet/contracts";

import { RetryableJobError, TerminalJobError } from "../jobs/failure";

/**
 * The ways the sandbox itself can fail a job - and, at the bottom, the one way
 * it can disappoint a caller without failing anything.
 *
 * Every job failure here extends `RetryableJobError` or `TerminalJobError`, which
 * means `classify()` needs no new branches and the retry policy stays the one
 * switch in `processor.ts`. Where an error sits in that hierarchy *is* the
 * retry decision, made once, at the point where someone had to reason about it,
 * rather than in a lookup table that can silently disagree with the categories.
 *
 * Note what is not here: a command exiting non-zero. That is an `ExecResult`,
 * not an exception, because the phase that ran the command is the only thing
 * that knows whether a non-zero exit is a failure. A red baseline is a fact
 * about the repository; a red `pnpm install` is a dead job. Same exit code,
 * different meanings, and the sandbox is not entitled to an opinion.
 */

/**
 * The Docker daemon is not reachable.
 *
 * Retryable: the machine may be mid-restart, and the sweeper will hand the job
 * to whichever worker has a working daemon.
 */
export class SandboxUnavailableError extends RetryableJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "sandbox_unavailable", options);
  }
}

/**
 * The image could not be pulled, or the container could not be created.
 *
 * Retryable, and it is worth saying why this one is not terminal when
 * `dependency_install_failed` is. A create failure is almost always about the
 * host - a registry timeout, disk pressure, a name collision with a container
 * being reaped - and none of those are properties of the job. An install
 * failure usually *is* a property of the job.
 */
export class SandboxCreateFailedError extends RetryableJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "sandbox_create_failed", options);
  }
}

/**
 * One command outlived its own `timeoutMs`.
 *
 * Terminal, and distinct from `JobTimedOutError`, which is the whole job
 * outliving `max_duration_seconds`. Keeping them apart is what lets the
 * timeline say "the install hung" rather than "the job was slow".
 */
export class CommandTimedOutError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "command_timed_out", options);
  }
}

/**
 * The container hit its memory limit and the kernel killed something in it.
 *
 * Terminal: the limit is fixed for the job, so a retry runs the same command
 * against the same ceiling. Raised only when the container's own
 * `State.OOMKilled` says so, which is what distinguishes a real memory kill
 * from every other process that happens to exit 137.
 */
export class OutOfMemoryError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "oom_killed", options);
  }
}

/**
 * The clone did not produce a repository.
 *
 * Terminal, and this is the one place where "terminal" is easy to argue with:
 * a clone failure can be a network blip. It is far more often a 404, a private
 * repository, or a branch that does not exist, and none of those improve on the
 * third attempt. Rivet only clones public HTTPS repositories at Milestone 2, so
 * anything needing credentials lands here too.
 */
export class RepoUnavailableError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "repo_unavailable", options);
  }
}

/**
 * The repository is not something this milestone knows how to build.
 *
 * No `package.json`, or a lockfile nothing here can drive. Terminal by
 * definition: the repository is what it is, and a retry clones the same tree.
 */
export class UnsupportedProjectError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "unsupported_project", options);
  }
}

/**
 * The dependency install exited non-zero.
 *
 * Terminal, and it is a judgment call rather than a deduction. An install
 * failure is sometimes a transient registry blip, which argues for a retry, but
 * it is just as often a lockfile that disagrees with its `package.json` - which
 * would fail identically three times while burning three attempts and three
 * containers. Revisit if the demo says otherwise.
 */
export class DependencyInstallFailedError extends TerminalJobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "dependency_install_failed", options);
  }
}

/**
 * Why a file could not be moved across the sandbox boundary.
 *
 * `not_found` is a path that is not there; `not_a_file` is a path that is there
 * and is a directory or a device.
 */
export type SandboxFileErrorReason = "not_found" | "not_a_file";

/**
 * A file operation asked for something that is not there.
 *
 * The one error in this file that is **not** a job failure, and that is the
 * whole point of it. Everything above extends `RetryableJobError` or
 * `TerminalJobError` because it describes a job that cannot continue. This one
 * describes a caller that asked a question with a boring answer: a model
 * guessing at a path that does not exist is the loop working, and it gets a
 * tool result it can read and correct rather than a dead job and a wasted
 * container.
 *
 * It follows that whoever calls `getFile` or `putFile` has to catch this. An
 * uncaught one reaching `classify()` lands in `unknown`, which is exactly as
 * useful as it sounds and is the symptom of a missing catch rather than of a
 * missing category.
 */
export class SandboxFileError extends Error {
  constructor(
    message: string,
    readonly reason: SandboxFileErrorReason,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SandboxFileError";
  }
}

/**
 * Raises the right error for a command that did not exit on its own.
 *
 * OOM is checked first: a container killed for memory also reports as killed
 * for timeout when the timeout is what noticed, and "ran out of memory" is the
 * more useful of the two answers.
 */
export function commandKilledError(
  result: { argv: string[]; timedOut: boolean; oomKilled: boolean },
  options?: { cause?: unknown },
): TerminalJobError | undefined {
  const command = result.argv.join(" ");
  if (result.oomKilled) {
    return new OutOfMemoryError(
      `\`${command}\` was killed: the sandbox ran out of memory.`,
      options,
    );
  }
  if (result.timedOut) {
    return new CommandTimedOutError(`\`${command}\` did not finish inside its timeout.`, options);
  }
  return undefined;
}

/** The categories the sandbox raises, for the tests that prove the table in the docs. */
export const SANDBOX_FAILURE_CATEGORIES = [
  "sandbox_unavailable",
  "sandbox_create_failed",
  "repo_unavailable",
  "unsupported_project",
  "dependency_install_failed",
  "command_timed_out",
  "oom_killed",
] as const satisfies readonly FailureCategory[];
