import { posix } from "node:path";

/**
 * Deciding whether a path the model produced is one it is allowed to touch.
 *
 * This is the containment that `packages/sandbox/src/paths.ts` deliberately
 * declines to do. The sandbox port has no opinion about which directory a
 * caller may use, and it should not: it moves one file across a boundary and
 * that is all. The opinion belongs here, in the layer that sits between a model
 * and a filesystem, because only this layer knows what the answer should look
 * like - a tool result the model reads and corrects, never an exception that
 * ends a session over a typo.
 *
 * Two things make this less theoretical than it sounds. The harness resolves
 * paths on the **host** before Rivet's operations ever see them, including `~`
 * expansion, so a model asking for `~/.ssh/id_rsa` arrives here as an absolute
 * path into the worker's own home directory. And the operations are the only
 * thing standing between that string and a `getFile` call. Reject it here or
 * not at all.
 */

/**
 * A path the model may not use, phrased for the model rather than for a log.
 *
 * Not a `TerminalJobError` and not a `RetryableJobError`, for the same reason
 * `SandboxFileError` is neither: a model guessing at a path is the loop
 * working. The tool layer turns this into a failed tool call, the model reads
 * the message, and the session continues.
 */
export class AgentPathError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentPathError";
  }
}

/**
 * Resolves one model-supplied path to an absolute path inside `workdir`.
 *
 * POSIX semantics explicitly, rather than the platform's. The path being
 * resolved names a location inside a Linux container; the process doing the
 * resolving may be running on macOS. `node:path`'s platform default would be
 * right by accident today and wrong the first time a worker runs on Windows,
 * and the failure would be a containment check that quietly stops containing.
 *
 * Normalisation happens before the comparison, which is the whole point:
 * `/repo/../etc/passwd` is only obviously an escape once it has been reduced to
 * `/etc/passwd`. The prefix test uses a trailing separator so that a sibling
 * directory whose name merely starts with the workdir's - `/home/node/workspace-2`
 * next to `/home/node/workspace` - is not mistaken for a child of it.
 */
export function resolveInside(workdir: string, path: string): string {
  const root = posix.resolve(workdir);
  const resolved = posix.resolve(root, path);

  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new AgentPathError(
      path,
      `${path} is outside the repository at ${root}. Every path must be inside the ` +
        `repository, either relative to it or absolute beneath it.`,
    );
  }

  return resolved;
}
