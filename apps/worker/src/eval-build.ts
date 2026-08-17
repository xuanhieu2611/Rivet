/* eslint-disable no-console -- this command is a local build transcript */
import { resolve } from "node:path";

import { buildBenchmarkFixtures } from "@rivet/core";

async function main(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const benchmarkRoot = resolve(repositoryRoot, process.env.RIVET_BENCHMARK_ROOT ?? "benchmarks");
  const outputRoot = resolve(repositoryRoot, ".rivet", "benchmarks");
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
