import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseLocalRepoUrl } from "@rivet/contracts";

import type { SeedCloneResult } from "../github/host-git";
import { RepoUnavailableError } from "../sandbox/errors";

/**
 * The evaluation harness's seed source, and why it is a source rather than a
 * special case.
 *
 * M9 taught provisioning that a repository can arrive as an archive the worker
 * host built, instead of as a clone the container performed. That was written
 * for a private GitHub repository and an installation token, but the shape it
 * left behind - "hand me a tar of a checked-out repository and the commit it
 * holds" - has nothing to do with GitHub. A benchmark case is the same
 * operation with a different remote and no credential at all.
 *
 * So M10 adds a second implementation of that shape rather than a second branch
 * inside the GitHub one. `SeedCloneResult` is deliberately reused: everything
 * downstream of the seed - `putArchive`, commit resolution, checkpoint restore,
 * dependency install - must not be able to tell which source produced the
 * archive, because the harness is only worth running if it measures the same
 * pipeline production runs.
 */

/** What the worker's host Git implementation needs to seed a benchmark case. */
export interface LocalSeedRequest {
  /** The `rivet-local:<case-id>` URL from the job row, unresolved. */
  repoUrl: string;
  baseBranch: string;
  /** The immutable commit a recovery attempt must reproduce, when known. */
  baseCommitSha?: string;
  timeoutMs: number;
  maxArchiveBytes: number;
  signal: AbortSignal;
}

/**
 * The host-side operation provisioning calls for a local benchmark repository.
 *
 * The same result type as `SeedClone` and deliberately no token field. A seed
 * source that cannot carry a credential cannot leak one.
 */
export type LocalSeed = (input: LocalSeedRequest) => Promise<SeedCloneResult>;

/**
 * The local seed source supplied by the worker to the core pipeline.
 *
 * Grouped with its bounds for the reason `AgentOptions` and
 * `GitHubPipelineOptions` are: `packages/core` holds no policy, so an operation
 * arrives with every ceiling it runs under or it does not arrive at all. A seed
 * with no archive bound is a worker heap problem waiting for a large fixture.
 */
export interface LocalSeedPipelineOptions {
  seed: LocalSeed;
  /** Bound on the complete archive, before it crosses into the sandbox. */
  seedMaxBytes: number;
  /** Host clone and archive timeout, distinct from the sandbox clone timeout. */
  cloneTimeoutMs: number;
}

/**
 * Turns `rivet-local:<case-id>` into an absolute path below the fixture root.
 *
 * Three refusals, and the third is the only one that needs a filesystem. The
 * scheme itself cannot carry a path (see `parseLocalRepoUrl`), and the joined
 * path is checked against the root textually - but a case directory that is a
 * symlink to somewhere else would satisfy both and still resolve outside. So
 * both sides are resolved through `realpath` and compared, which is the check
 * that actually holds when the attacker controls the fixture directory rather
 * than the URL.
 *
 * Everything here fails as `repo_unavailable`: from the job's side an
 * unresolvable benchmark repository is a repository Rivet cannot work with,
 * which is exactly what that category already means.
 */
export async function resolveBenchmarkRepositoryPath(input: {
  repoUrl: string;
  fixtureRoot: string;
}): Promise<string> {
  const caseId = parseLocalRepoUrl(input.repoUrl);
  if (caseId === null) {
    throw new RepoUnavailableError(
      `${input.repoUrl} is not a valid rivet-local:<case-id> benchmark repository URL.`,
    );
  }

  const root = await realpathOrThrow(
    resolve(input.fixtureRoot),
    `The benchmark fixture root ${input.fixtureRoot} does not exist. Run pnpm eval:build.`,
  );
  const candidate = join(root, benchmarkRepositoryDirname(caseId));
  const resolved = await realpathOrThrow(
    candidate,
    `Benchmark ${caseId} has no built repository at ${candidate}. Run pnpm eval:build.`,
  );

  if (!isInside(root, resolved)) {
    throw new RepoUnavailableError(
      `Benchmark ${caseId} resolves outside the fixture root and was refused.`,
    );
  }

  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new RepoUnavailableError(`Benchmark ${caseId} does not name a repository directory.`);
  }

  return resolved;
}

/** The directory name the fixture builder writes for a case. */
export function benchmarkRepositoryDirname(caseId: string): string {
  return `${caseId}.git`;
}

async function realpathOrThrow(path: string, message: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new RepoUnavailableError(message, { cause: error });
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return false;
  const rest = relative(root, candidate);
  return rest.length > 0 && !rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest);
}
