import { isAbsolute, resolve } from "node:path";

import { resolveBenchmarkRepositoryPath, type LocalSeedPipelineOptions } from "@rivet/core";

import type { EvalConfig } from "./config";
import { localSeed } from "./git";

/**
 * The worker's half of `RIVET_EVAL`, and the exact counterpart of `github.ts`.
 *
 * Two things are assembled here and nowhere else: the resolution of a job's
 * `rivet-local:<case-id>` URL to a built bare repository below the fixture
 * root, and the host Git operation that clones and archives it. `@rivet/core`
 * receives them as one optional field, which is what keeps the package free of
 * both the filesystem layout and the environment.
 *
 * Returns `undefined` under `RIVET_EVAL=off`, which leaves
 * `PipelineOptions.localSeed` absent. A job that names a local repository then
 * fails with a stated reason instead of falling through to a clone that cannot
 * work - which is the mode CI, every existing suite and an ordinary worker run
 * under, because nothing except the evaluation runner creates such a job.
 */
export function createLocalSeedOptions(
  config: EvalConfig,
  options: { repositoryRoot: string },
): LocalSeedPipelineOptions | undefined {
  if (config.mode === "off") return undefined;

  const fixtureRoot = resolveRoot(config.fixtureRoot, options.repositoryRoot);

  return {
    seed: async (request) => {
      // Resolution happens per request rather than at startup: the fixture root
      // is built by `pnpm eval:build`, which a person may well run after the
      // worker is already up, and a missing case must fail that job rather than
      // the worker.
      const repositoryPath = await resolveBenchmarkRepositoryPath({
        repoUrl: request.repoUrl,
        fixtureRoot,
      });
      return localSeed({
        repositoryPath,
        baseBranch: request.baseBranch,
        ...(request.baseCommitSha === undefined ? {} : { baseCommitSha: request.baseCommitSha }),
        timeoutMs: request.timeoutMs,
        maxArchiveBytes: request.maxArchiveBytes,
        signal: request.signal,
      });
    },
    seedMaxBytes: config.seedMaxBytes,
    cloneTimeoutMs: config.cloneTimeoutMs,
  };
}

/** Benchmark roots are configured relative to the repository unless absolute. */
export function resolveRoot(value: string, repositoryRoot: string): string {
  return isAbsolute(value) ? value : resolve(repositoryRoot, value);
}
