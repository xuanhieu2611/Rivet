/* eslint-disable no-console -- this command is intentionally terminal-oriented */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getEvaluationSuite } from "@rivet/core";
import { closeDb } from "@rivet/database";
import { closeJobQueue, closeRedis } from "@rivet/queue";
import { DockerSandboxProvider } from "@rivet/sandbox";

import {
  DEFAULT_BENCHMARK_FIXTURE_ROOT,
  DEFAULT_BENCHMARK_ROOT,
  findRepositoryRoot,
  loadRootEnv,
} from "./config";
import { createLocalSeedOptions, resolveRoot } from "./eval";
import {
  parseEvaluationRuntimeConfig,
  prepareEvaluationCases,
  regradeEvaluationSuite,
  type EvaluationRuntime,
} from "./eval-run";

async function main(): Promise<void> {
  loadRootEnv();
  const suiteId = process.argv[2];
  if (!suiteId || suiteId.startsWith("-")) {
    throw new Error("Usage: pnpm eval:grade <suite-id>");
  }

  const repositoryRoot = findRepositoryRoot();
  const runtimeConfig = parseEvaluationRuntimeConfig(process.env);
  if (runtimeConfig.sandbox.mode !== "docker") {
    throw new Error("pnpm eval:grade needs RIVET_SANDBOX=docker for the grading container.");
  }
  const benchmarkRoot = resolveRoot(
    process.env.RIVET_BENCHMARK_ROOT ?? DEFAULT_BENCHMARK_ROOT,
    repositoryRoot,
  );
  const fixtureRoot = resolveRoot(
    process.env.RIVET_BENCHMARK_FIXTURE_ROOT ?? DEFAULT_BENCHMARK_FIXTURE_ROOT,
    repositoryRoot,
  );

  try {
    // The suite determines the case ids. Loading it before constructing a
    // provider means a typo fails without touching Docker.
    const suite = await getEvaluationSuite(suiteId);
    if (!suite) throw new Error(`Evaluation suite ${suiteId} was not found.`);
    await prepareEvaluationCases(benchmarkRoot, suite, {
      fixtureRoot,
      requireBuiltRepositories: true,
      allowVersionMismatch: true,
    });
    const localSeed = createLocalSeedOptions(
      { ...runtimeConfig.eval, mode: "on" },
      { repositoryRoot },
    );
    if (!localSeed) throw new Error("Could not configure the local benchmark seed source.");

    const runtime: EvaluationRuntime = {
      config: runtimeConfig,
      sandbox: new DockerSandboxProvider({ workerId: `rivet-eval-grade-${process.pid}` }),
      localSeed,
    };

    const runs = await regradeEvaluationSuite(suiteId, {
      runtime,
      repositoryRoot,
      log: console.log,
    });
    console.log(`Re-graded ${runs.length} run${runs.length === 1 ? "" : "s"} in ${suiteId}.`);
  } finally {
    await closeJobQueue();
    await closeRedis();
    await closeDb();
  }
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
