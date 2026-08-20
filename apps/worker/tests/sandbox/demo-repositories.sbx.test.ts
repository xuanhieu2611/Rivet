import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildBenchmarkFixtures,
  gradeEvaluationRun,
  loadBenchmarkCases,
  loadHiddenTestFiles,
  sha256CheckpointPatch,
  type BuiltBenchmarkCase,
  type JobCheckpoint,
  type LoadedBenchmarkCase,
} from "@rivet/core";
import { DockerSandboxProvider } from "@rivet/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_IMAGE, findRepositoryRoot } from "../../src/config";
import { createLocalSeedOptions } from "../../src/eval";

/**
 * Milestone 12 acceptance run G.
 *
 * These are the two repositories shown in the public demo, so merely loading
 * their case files is not enough. Each checked-in known-good patch goes through
 * the production M10 grader in a second real container, against hidden tests
 * that were absent from the seeded repository. This keeps "the demo task is
 * solvable" as a measured claim and catches drift between the GitHub seed, its
 * benchmark mirror, the intended solution and the hidden contract.
 */

const CASE_IDS = ["rivet-demo-booking", "rivet-demo-reservations"] as const;
const REPOSITORY_ROOT = findRepositoryRoot(import.meta.dirname);
const BENCHMARK_ROOT = resolve(REPOSITORY_ROOT, "benchmarks");
const SOLUTION_ROOT = resolve(import.meta.dirname, "../fixtures/demo-solutions");
const WORKDIR = process.env.SANDBOX_WORKDIR ?? "/home/node/workspace";
const MAX_PATCH_BYTES = 4 * 1_024 * 1_024;

let temporaryRoot: string;
let fixtureRoot: string;
let builtCases: Map<string, BuiltBenchmarkCase>;
let loadedCases: Map<string, LoadedBenchmarkCase>;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "rivet-demo-cases-"));
  fixtureRoot = join(temporaryRoot, "built");
  builtCases = new Map(
    (
      await buildBenchmarkFixtures({
        benchmarkRoot: BENCHMARK_ROOT,
        outputRoot: fixtureRoot,
        lockfileMode: "verify",
      })
    ).map((benchmark) => [benchmark.id, benchmark]),
  );
  loadedCases = new Map(
    (await loadBenchmarkCases(BENCHMARK_ROOT)).map((benchmark) => [benchmark.id, benchmark]),
  );
});

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("Milestone 12 demo repositories", () => {
  for (const caseId of CASE_IDS) {
    it(`${caseId} builds and its known solution grades as passed`, async () => {
      const built = requireCase(builtCases, caseId);
      const loaded = requireCase(loadedCases, caseId);
      const patch = await readFile(join(SOLUTION_ROOT, `${caseId}.patch`));
      const hiddenFiles = await loadHiddenTestFiles(loaded.hiddenDirectory);
      const localSeed = createLocalSeedOptions(
        {
          mode: "on",
          benchmarkRoot: BENCHMARK_ROOT,
          fixtureRoot,
          cloneTimeoutMs: 120_000,
          seedMaxBytes: 64 * 1_024 * 1_024,
          concurrency: 1,
        },
        { repositoryRoot: REPOSITORY_ROOT },
      );
      if (!localSeed) throw new Error("The demo grader needs its local seed source.");

      const result = await gradeEvaluationRun({
        jobId: `demo-grade-${caseId}`,
        job: {
          status: "completed",
          failureCategory: null,
          failureReason: null,
          reviewDecision: "approve",
        },
        validationOutcome: "verified",
        benchmark: {
          id: caseId,
          repoUrl: `rivet-local:${caseId}`,
          baseBranch: "main",
          setupCommand: loaded.spec.setupCommand,
          validationCommand: loaded.spec.validationCommand,
          hiddenFiles,
        },
        readCheckpoint: () => Promise.resolve(checkpointFor(caseId, built.baseCommitSha, patch)),
        seed: localSeed.seed,
        seedTimeoutMs: localSeed.cloneTimeoutMs,
        seedMaxBytes: localSeed.seedMaxBytes,
        sandbox: {
          provider: new DockerSandboxProvider({
            workerId: `demo-grade-${caseId}-${process.pid}`,
            reapGraceMs: 0,
          }),
          image: process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
          workdir: WORKDIR,
          memoryBytes: 512 * 1_024 * 1_024,
          nanoCpus: 1_000_000_000,
          pidsLimit: 128,
          commandTimeoutMs: 60_000,
          validationTimeoutMs: 120_000,
          maxOutputBytes: 65_536,
          maxPatchBytes: MAX_PATCH_BYTES,
        },
        signal: new AbortController().signal,
      });

      expect(result.detail).toBeNull();
      expect(result.result).toBe("passed");
      expect(result.score).toBe(1);
      expect(result.hiddenTests?.passed).toBe(result.hiddenTests?.total);
      expect(result.hiddenTests?.total ?? 0).toBeGreaterThan(0);
    }, 600_000);
  }
});

function checkpointFor(caseId: string, baseCommitSha: string, patch: Buffer): JobCheckpoint {
  return {
    id: 1,
    jobId: `demo-grade-${caseId}`,
    sequence: 1,
    attemptCount: 1,
    kind: "phase_boundary",
    completedPhase: "reviewing",
    resumePhase: "finalizing",
    agentTurn: null,
    baseCommitSha,
    sandboxId: "demo-source-container",
    envFingerprint: {},
    state: { version: 1 },
    patchFormat: "git_binary_full_index",
    patchCompression: "gzip",
    patchSha256: sha256CheckpointPatch(patch),
    patchByteSize: patch.byteLength,
    patchCompressedBytes: patch.byteLength,
    patch,
    restorePatch: patch,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function requireCase<T>(cases: Map<string, T>, caseId: string): T {
  const value = cases.get(caseId);
  if (!value) throw new Error(`Benchmark ${caseId} did not load.`);
  return value;
}
