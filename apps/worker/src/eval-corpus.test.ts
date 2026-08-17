import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildBenchmarkFixtures, loadBenchmarkCases } from "@rivet/core";
import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_BENCHMARK_ROOT, findRepositoryRoot } from "./config";

/**
 * Acceptance run A, applied to the corpus rather than to the builder.
 *
 * The builder's determinism is proven against synthetic cases in
 * `packages/core`; this is the assertion that catches a *case* edited without a
 * rebuild. Every case in `benchmarks/` is loaded, validated and rebuilt into a
 * throwaway directory with `lockfileMode: "verify"`, so a seed tree that no
 * longer produces the commit its git-tracked `case.lock.json` pins fails here,
 * naming both SHAs, rather than silently changing what a benchmark means
 * between two suites that both claim to have run it.
 *
 * Deliberately the only assertion this suite makes about the corpus. The five
 * cases are content and will keep being edited - their hidden tests especially
 * - and a harness test that breaks when a hidden test is improved is a test
 * that teaches people to stop improving hidden tests. Runs A-G assert harness
 * behaviour against the two suite-owned fixtures under `tests/fixtures/`.
 */

const REPOSITORY_ROOT = findRepositoryRoot(import.meta.dirname);
const BENCHMARK_ROOT = resolve(REPOSITORY_ROOT, DEFAULT_BENCHMARK_ROOT);
const outputs: string[] = [];

afterAll(async () => {
  await Promise.all(outputs.map((path) => rm(path, { recursive: true, force: true })));
});

describe("the benchmark corpus", () => {
  it("loads, validates and builds to the commits its lockfiles pin", async () => {
    const loaded = await loadBenchmarkCases(BENCHMARK_ROOT);
    expect(loaded.length).toBeGreaterThanOrEqual(5);
    // Every case is pinned. A case with no lockfile is a case whose commit
    // nothing reproduces, and the runner refuses to spend model calls on one.
    expect(loaded.filter((benchmark) => benchmark.lock === null)).toEqual([]);

    const outputRoot = await mkdtemp(join(tmpdir(), "rivet-benchmark-corpus-"));
    outputs.push(outputRoot);
    const built = await buildBenchmarkFixtures({
      benchmarkRoot: BENCHMARK_ROOT,
      outputRoot,
      lockfileMode: "verify",
    });

    expect(built.map((benchmark) => benchmark.id).sort()).toEqual(
      loaded.map((benchmark) => benchmark.id).sort(),
    );
    for (const benchmark of built) {
      expect(benchmark.baseCommitSha).toBe(benchmark.lock.baseCommitSha);
      expect(benchmark.versionHash).toBe(benchmark.lock.versionHash);
    }
  }, 120_000);
});
