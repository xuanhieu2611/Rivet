/* eslint-disable no-console -- this command is intentionally interactive */
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { failureLabelSchema, type FailureLabel } from "@rivet/contracts";
import { closeDb } from "@rivet/database";
import {
  getEvaluationRun,
  getJob,
  labelEvaluationRun,
  listArtifacts,
  listEvaluationRuns,
  listUnlabeledEvaluationRuns,
} from "@rivet/core";

import { findRepositoryRoot, loadRootEnv } from "./config";

interface LabelArgs {
  suiteId: string | null;
  runIds: string[];
  label: string | null;
  force: boolean;
}

function parseArgs(argv: readonly string[]): LabelArgs {
  const parsed: LabelArgs = { suiteId: null, runIds: [], label: null, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--suite") {
      parsed.suiteId = requireArg(argv, ++index, argument);
    } else if (argument === "--run" || argument === "--run-id") {
      parsed.runIds.push(requireArg(argv, ++index, argument));
    } else if (argument === "--label") {
      parsed.label = requireArg(argv, ++index, argument);
    } else if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exitCode = 0;
      return parsed;
    } else {
      throw new Error(`Unknown eval:label argument ${argument}.`);
    }
  }
  return parsed;
}

function requireArg(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} needs a value.`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: pnpm eval:label [options]

Options:
  --suite <suite-id>        Limit the queue to one suite.
  --run <run-id>            Label one run (repeatable).
  --label <label>           Apply one taxonomy label without prompting.
  --force                   Permit replacing an existing automatic label.
`);
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseArgs(process.argv.slice(2));
  if (process.exitCode !== undefined) return;
  // Resolve the root before opening the database. It gives a command run from a
  // nested directory the same repository-root semantics as every other worker
  // CLI, even though labelling itself does not read benchmark files yet.
  findRepositoryRoot();

  let input: ReturnType<typeof createInterface> | null = null;
  try {
    const runs = await selectRuns(args);
    if (runs.length === 0) {
      console.log("No unlabeled failed evaluation runs.");
      return;
    }

    const label = args.label === null ? null : parseLabel(args.label);
    input =
      process.stdin.isTTY && process.stdout.isTTY && label === null
        ? createInterface({ input: process.stdin, output: process.stdout })
        : null;

    for (const run of runs) {
      if (run.result !== "failed") {
        console.log(`${run.id}: only failed evaluation runs can receive a manual label.`);
        continue;
      }
      if (run.failureCategory !== null && !args.force) {
        console.log(
          `${run.id}: already labeled ${run.failureCategory}; use --force to replace it.`,
        );
        continue;
      }

      await printRunContext(run);
      const selected = label ?? (await promptForLabel(input));
      if (selected === null) {
        console.log(`${run.id}: skipped.`);
        continue;
      }

      const updated = await labelEvaluationRun({
        id: run.id,
        failureCategory: selected,
        failureLabelSource: "manual",
      });
      if (!updated) throw new Error(`Evaluation run ${run.id} disappeared while labeling.`);
      console.log(`${run.id}: labeled ${selected}.`);
    }
  } finally {
    input?.close();
    await closeDb();
  }
}

async function selectRuns(args: LabelArgs) {
  if (args.runIds.length > 0) {
    const runs = await Promise.all(args.runIds.map((id) => getEvaluationRun(id)));
    const missing = args.runIds.filter((_, index) => runs[index] === null);
    if (missing.length > 0) throw new Error(`Evaluation run not found: ${missing.join(", ")}.`);
    return runs.filter((run): run is NonNullable<typeof run> => run !== null);
  }

  if (args.suiteId) {
    const runs = await listEvaluationRuns(args.suiteId);
    return runs.filter(
      (run) => run.result === "failed" && (run.failureCategory === null || args.force),
    );
  }

  return listUnlabeledEvaluationRuns();
}

function parseLabel(value: string): FailureLabel {
  const parsed = failureLabelSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid failure label ${JSON.stringify(value)}. Choose one of: ${failureLabelSchema.options.join(", ")}.`,
    );
  }
  return parsed.data;
}

async function promptForLabel(
  input: ReturnType<typeof createInterface> | null,
): Promise<FailureLabel | null> {
  if (!input) {
    throw new Error("An interactive terminal or --label is required for pnpm eval:label.");
  }
  const answer = (await input.question("Label (or skip): ")).trim();
  if (answer === "" || answer.toLowerCase() === "skip") return null;
  return parseLabel(answer);
}

async function printRunContext(
  run: Awaited<ReturnType<typeof listEvaluationRuns>>[number],
): Promise<void> {
  const metrics = run.metrics;
  const job = run.jobId ? await getJob(run.jobId) : null;
  const artifacts = run.jobId ? await listArtifacts(run.jobId) : [];
  const diff = [...artifacts].reverse().find((artifact) => artifact.type === "diff_stat");
  console.log("");
  console.log(
    `${run.id} | ${run.benchmarkId} | arm=${run.arm} | repetition=${run.repetition} | ` +
      `result=${run.result} | score=${run.score === null ? "-" : run.score.toFixed(4)}`,
  );
  console.log(`job: ${run.jobId ?? "none"}`);
  console.log(`validation: ${metrics.validationOutcome ?? "none"}`);
  console.log(`review: ${job?.reviewDecision ?? metrics.reviewDecision ?? "none"}`);
  const filesChanged = metrics.filesChanged ?? metadataCount(diff?.metadata?.filesChanged);
  const insertions = metrics.insertions ?? metadataCount(diff?.metadata?.insertions);
  const deletions = metrics.deletions ?? metadataCount(diff?.metadata?.deletions);
  console.log(`diff: ${filesChanged ?? "none"} files, +${insertions ?? "-"}/-${deletions ?? "-"}`);
  console.log(
    `hidden tests: ${metrics.hiddenTestsPassed ?? "-"}/${metrics.hiddenTestsTotal ?? "-"}; ` +
      "inspect the linked job timeline and diff before choosing a label.",
  );
}

function metadataCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
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
