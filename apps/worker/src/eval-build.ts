/* eslint-disable no-console -- this command is a local build transcript */
import { buildBenchmarkFixtures } from "@rivet/core";

import {
  DEFAULT_BENCHMARK_FIXTURE_ROOT,
  DEFAULT_BENCHMARK_ROOT,
  findRepositoryRoot,
} from "./config";
import { resolveRoot } from "./eval";

async function main(): Promise<void> {
  // The same two roots the worker's local seed source reads, resolved the same
  // way, so a case that builds here is a case a job can be seeded from.
  const repositoryRoot = findRepositoryRoot();
  const benchmarkRoot = resolveRoot(
    process.env.RIVET_BENCHMARK_ROOT ?? DEFAULT_BENCHMARK_ROOT,
    repositoryRoot,
  );
  const outputRoot = resolveRoot(
    process.env.RIVET_BENCHMARK_FIXTURE_ROOT ?? DEFAULT_BENCHMARK_FIXTURE_ROOT,
    repositoryRoot,
  );
  const built = await buildBenchmarkFixtures({ benchmarkRoot, outputRoot });

  if (built.length === 0) {
    console.log(`No benchmark cases found under ${benchmarkRoot}.`);
    return;
  }

  console.log(`Built ${built.length} benchmark case${built.length === 1 ? "" : "s"}.`);
  for (const benchmark of built) {
    console.log(
      `- ${benchmark.id}: ${benchmark.baseCommitSha} ` +
        `(version ${benchmark.versionHash}, ${benchmark.bareRepository})`,
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
