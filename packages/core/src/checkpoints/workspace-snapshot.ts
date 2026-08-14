import { randomUUID } from "node:crypto";

import type { Sandbox } from "../sandbox/sandbox";
import { CheckpointCorruptError, CheckpointTooLargeError } from "../jobs/failure";

/** The machine-readable totals attached to a checkpoint event. */
export interface CheckpointPatchStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** A complete workspace patch and the small facts useful on a timeline. */
export interface WorkspaceSnapshot {
  patch: Buffer;
  stats: CheckpointPatchStats;
}

export interface CaptureWorkspacePatchInput {
  sandbox: Pick<Sandbox, "exec">;
  /** The cloned repository, not the worker's filesystem. */
  repositoryDir: string;
  signal: AbortSignal;
  /** Total time allowed for the complete capture and cleanup. */
  timeoutMs: number;
  /** Maximum uncompressed patch size accepted by the checkpoint store. */
  maxBytes: number;
}

/** A capture failure carries the command evidence needed by checkpoint.rejected. */
export class WorkspaceSnapshotError extends CheckpointCorruptError {
  readonly argv: readonly string[];
  readonly stderr: string;

  constructor(
    message: string,
    details: { argv?: readonly string[]; stderr?: string } = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorkspaceSnapshotError";
    this.argv = details.argv ?? [];
    this.stderr = details.stderr ?? "";
  }
}

/**
 * Captures the working tree without touching its real Git index.
 *
 * The temporary index is inside the sandbox but outside the repository. Git's
 * binary patch format is ASCII, so converting the command result back to UTF-8
 * preserves the exact bytes that `git diff` produced, including binary changes.
 * The index is removed in a separate cleanup command on every exit path.
 */
export async function captureWorkspacePatch(
  input: CaptureWorkspacePatchInput,
): Promise<WorkspaceSnapshot> {
  validateInput(input);

  const indexPath = `/tmp/rivet-checkpoint-${randomUUID()}.index`;
  const env = { GIT_INDEX_FILE: indexPath };
  const deadline = new AbortController();
  const timeoutError = new WorkspaceSnapshotError(
    `Workspace checkpoint capture exceeded its ${input.timeoutMs}ms timeout.`,
  );
  const timer = setTimeout(() => deadline.abort(timeoutError), input.timeoutMs);
  const signal = AbortSignal.any([input.signal, deadline.signal]);

  let failed = false;
  let failure: unknown;
  let snapshot: WorkspaceSnapshot | undefined;

  try {
    await runSnapshotCommand(input, signal, deadline.signal, ["git", "read-tree", "HEAD"], env);
    await runSnapshotCommand(input, signal, deadline.signal, ["git", "add", "-A"], env);

    const diff = await runSnapshotCommand(
      input,
      signal,
      deadline.signal,
      [
        "git",
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
      ],
      env,
    );

    const patch = Buffer.from(diff.stdout, "utf8");
    if (patch.byteLength > input.maxBytes) {
      throw new CheckpointTooLargeError(
        `Workspace checkpoint patch is ${patch.byteLength} bytes, above the ${input.maxBytes}-byte limit.`,
      );
    }

    snapshot = { patch, stats: parseCheckpointPatchStats(patch) };
  } catch (error) {
    failed = true;
    failure = error;
  }

  let cleanupFailure: unknown;
  try {
    await removeTemporaryIndex(input, indexPath);
  } catch (error) {
    cleanupFailure = error;
  } finally {
    clearTimeout(timer);
  }

  if (failed) throw asError(failure);
  if (cleanupFailure) throw asError(cleanupFailure);
  if (!snapshot)
    throw new WorkspaceSnapshotError("Workspace checkpoint capture produced no patch.");
  return snapshot;
}

/**
 * Counts changed paths and textual lines from the lossless Git patch.
 *
 * Binary patch payload lines are intentionally ignored. A line beginning with
 * `+` or `-` in a binary payload is encoded data, not a source line, so the
 * parser stays in text mode only until the next `diff --git` header.
 */
export function parseCheckpointPatchStats(patch: Uint8Array): CheckpointPatchStats {
  const stats: CheckpointPatchStats = { filesChanged: 0, insertions: 0, deletions: 0 };
  let binary = false;

  for (const line of Buffer.from(patch).toString("utf8").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      stats.filesChanged += 1;
      binary = false;
      continue;
    }
    if (line === "GIT binary patch" || line.startsWith("Binary files ")) {
      binary = true;
      continue;
    }
    if (binary) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) stats.insertions += 1;
    if (line.startsWith("-")) stats.deletions += 1;
  }

  return stats;
}

async function runSnapshotCommand(
  input: CaptureWorkspacePatchInput,
  signal: AbortSignal,
  deadlineSignal: AbortSignal,
  argv: string[],
  env: Record<string, string>,
) {
  throwIfCaptureAborted(input.signal, deadlineSignal);

  let result;
  try {
    result = await input.sandbox.exec({
      argv,
      cwd: input.repositoryDir,
      timeoutMs: input.timeoutMs,
      signal,
      env,
      maxOutputBytes: input.maxBytes,
    });
  } catch (error) {
    throwIfCaptureAborted(input.signal, deadlineSignal);
    throw new WorkspaceSnapshotError(
      `Could not run checkpoint command \`${argv.join(" ")}\`: ${describeError(error)}.`,
      { argv, stderr: "" },
      { cause: error },
    );
  }

  throwIfCaptureAborted(input.signal, deadlineSignal);

  if (result.oomKilled || result.timedOut) {
    throw new WorkspaceSnapshotError(
      `Checkpoint command \`${argv.join(" ")}\` was killed before it completed.` +
        (result.oomKilled
          ? " The sandbox ran out of memory."
          : " It exceeded the capture timeout."),
      { argv, stderr: result.stderr },
    );
  }
  if (result.truncated) {
    throw new WorkspaceSnapshotError(
      `Checkpoint command \`${argv.join(" ")}\` produced truncated output; the workspace patch cannot be trusted.`,
      { argv, stderr: result.stderr },
    );
  }
  if (result.exitCode !== 0) {
    throw new WorkspaceSnapshotError(
      `Checkpoint command \`${argv.join(" ")}\` failed with exit code ${String(result.exitCode)}: ` +
        `${result.stderr.trim() || "no stderr"}.`,
      { argv, stderr: result.stderr },
    );
  }

  return result;
}

async function removeTemporaryIndex(
  input: CaptureWorkspacePatchInput,
  indexPath: string,
): Promise<void> {
  const cleanupController = new AbortController();
  try {
    const result = await input.sandbox.exec({
      argv: ["rm", "-f", indexPath, `${indexPath}.lock`],
      cwd: "/",
      timeoutMs: Math.min(input.timeoutMs, 5_000),
      signal: cleanupController.signal,
      maxOutputBytes: 1_024,
    });

    if (result.exitCode !== 0 || result.truncated || result.timedOut || result.oomKilled) {
      throw new WorkspaceSnapshotError(
        `Could not remove the temporary checkpoint index \`${indexPath}\`.`,
        { argv: ["rm", "-f", indexPath, `${indexPath}.lock`], stderr: result.stderr },
      );
    }
  } finally {
    cleanupController.abort();
  }
}

function throwIfCaptureAborted(signal: AbortSignal, deadlineSignal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  if (deadlineSignal.aborted) {
    throw abortReason(deadlineSignal);
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Checkpoint capture aborted.");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validateInput(input: CaptureWorkspacePatchInput): void {
  if (input.repositoryDir.trim().length === 0) {
    throw new WorkspaceSnapshotError("A workspace checkpoint requires a repository directory.");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new WorkspaceSnapshotError(`Invalid checkpoint capture timeout: ${input.timeoutMs}.`);
  }
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new CheckpointCorruptError(`Invalid checkpoint capture byte limit: ${input.maxBytes}.`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
