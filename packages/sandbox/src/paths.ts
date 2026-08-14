import { posix } from "node:path";

/**
 * Whether an absolute path inside a sandbox names a file that could be written.
 *
 * Shared by both implementations of the port because both have the same trap to
 * avoid: `posix.basename` strips a trailing slash, so `/repo/src/` comes back as
 * `src` and a write aimed at a directory would quietly create a file with the
 * directory's name next to it. The caller said "directory" and got a file, and
 * nothing anywhere reported a problem.
 *
 * Path *containment* - is this inside the repository the agent was given - is
 * deliberately not decided here. That is the tool layer's job in
 * `packages/agent`, because it needs to answer the model with a tool error it
 * can correct rather than an exception, and because the sandbox port has no
 * opinion about which directory a caller is allowed to touch.
 */
export function namesAFile(path: string): boolean {
  if (path.length === 0 || path.endsWith("/")) return false;
  const name = posix.basename(path);
  return name.length > 0 && name !== "." && name !== "..";
}
