import {
  jobOutcomeFrom,
  serializeValidationReport,
  type BaselineReport,
  type CheckComparison,
  type CheckKind,
  type CheckRun,
  type CheckStatus,
  type ValidationOutcome,
} from "@rivet/contracts";

import type { BaselineOutcome } from "../events/baseline-log";
import { NoChangesProducedError, TerminalJobError, ValidationFailedError } from "../jobs/failure";
import { commandKilledError } from "../sandbox/errors";
import { runCheck } from "./check-runner";
import { problem, splitLines } from "./command-output";
import type { PhaseContext, RecordedCommand } from "./phase-context";
import type { PipelineOptions } from "./phases";
import type { PhaseDirective } from "./run-pipeline";
import { probeValidation } from "./project-probe";
import { COREPACK_ENV, REPO_DIRNAME } from "./project";
import { selectTargetedTests, type TargetedTestSelection } from "./targeted-tests";
import { attribute } from "./test-report";
import type {
  ResolvedCheckConfig,
  ResolvedTargetedConfig,
  ResolvedValidation,
} from "./validation-config";

const STAGE_ARGV = ["git", "add", "-A"];
const DIFF_ARGV = ["git", "diff", "--cached"];
const NUMSTAT_ARGV = ["git", "diff", "--cached", "--numstat"];
const TRACKED_ARGV = ["git", "ls-files", "--cached"];
const CHECK_ORDER = ["targeted_test", "test", "typecheck", "lint"] as const;

/**
 * Captures the implementation evidence first, then independently resolves and
 * runs every validation check for this attempt. Nothing relies on `analyzing`
 * process memory or its sandbox, which is required for M6 recovery.
 */
export function validationPhase(
  options: PipelineOptions,
): (ctx: PhaseContext) => Promise<PhaseDirective> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;

  return async function validate(ctx: PhaseContext): Promise<PhaseDirective> {
    const diff = await captureDiff(ctx, options, repoDir);
    if (!diff.changed) {
      throw new NoChangesProducedError(
        "The coding session finished without changing anything: `git diff --cached` is empty " +
          "against the commit the repository was cloned at. There is nothing to validate and " +
          "nothing to keep.",
      );
    }

    // These remain the first durable outputs from validation. Later probing,
    // selection, check execution, or report parsing cannot hide the work.
    await recordDiff(ctx, diff);

    const tracked = await readTrackedFiles(ctx, options, repoDir);
    const selection = selectTargetedTests({
      changedPaths: diff.stat.paths,
      trackedFiles: tracked,
      maxFiles: options.targetedMaxFiles,
    });
    const resolved = await probeValidation(ctx, {
      repoDir,
      commandTimeoutMs: options.commandTimeoutMs,
    });
    const reporterDirectoryReady = needsReporterDirectory(resolved, selection)
      ? await prepareReporterDirectory(ctx, options)
      : false;
    const runs = await executeChecks(
      ctx,
      options,
      repoDir,
      resolved,
      selection,
      reporterDirectoryReady,
    );

    const baselineReport = await ctx.readBaselineReport();
    const legacyBaseline = baselineReport === null ? await ctx.readBaseline() : null;
    const comparisons = compareChecks(runs, baselineReport, legacyBaseline);
    const outcome = jobOutcomeFrom(comparisons);
    const targetedPaths = "paths" in selection ? selection.paths : undefined;

    for (const comparison of comparisons) {
      await recordCheck(ctx, comparison, targetedPaths);
    }

    await ctx.artifact({
      type: "validation_report",
      content: serializeValidationReport({
        outcome,
        checks: comparisons,
        ...(targetedPaths === undefined ? {} : { targetedPaths }),
      }),
      requireComplete: true,
      message: "Validation report artifact recorded.",
    });

    const test = comparisons.find((check) => check.kind === "test");
    const attribution = test?.attribution;
    await ctx.event({
      type: "validation.recorded",
      message: describeOutcome(outcome, test),
      data: {
        validation: outcome,
        ...(test?.baseline === null || test?.baseline === undefined
          ? {}
          : { baseline: test.baseline }),
        filesChanged: diff.stat.filesChanged,
        insertions: diff.stat.insertions,
        deletions: diff.stat.deletions,
        ...(test?.argv === undefined ? {} : { argv: test.argv }),
        ...(test?.exitCode === undefined ? {} : { exitCode: test.exitCode }),
        ...(test?.durationMs === undefined ? {} : { durationMs: test.durationMs }),
        ...(test?.commandId === undefined ? {} : { commandId: test.commandId }),
        ...(attribution === undefined
          ? {}
          : {
              newFailures: attribution.newFailures.length,
              preExistingFailures: attribution.preExistingFailures.length,
              fixedFailures: attribution.fixedFailures.length,
            }),
        ...(targetedPaths === undefined ? {} : { targetedPaths }),
      },
    });

    ctx.log.info({ outcome, ...diff.stat }, "validation compared every check against its baseline");

    const failing = comparisons.find(isBindingFailure);
    if (failing) throw new ValidationFailedError(describeFailure(failing));

    // Nothing to ask the runner for: the queue carries on. See `PhaseDirective`.
    return undefined;
  };
}

/** The M5 comparison table, retained as the per-check primitive. */
export function validationOutcome(
  baseline: BaselineOutcome | null,
  after: CheckStatus,
): ValidationOutcome {
  if (after === "skipped") return "unverified";
  switch (baseline) {
    case "passed":
      return after === "passed" ? "verified" : "regressed";
    case "failed":
      return after === "passed" ? "fixed" : "unresolved";
    case "skipped":
    case null:
      return "unverified";
  }
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  paths: string[];
}

export function parseNumstat(text: string): DiffStat {
  const stat: DiffStat = { filesChanged: 0, insertions: 0, deletions: 0, paths: [] };
  for (const line of text.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const added = countField(fields[0]);
    const removed = countField(fields[1]);
    if (added === undefined || removed === undefined) continue;
    const path = fields.slice(2).join("\t").trim();
    if (path.length === 0) continue;
    stat.filesChanged += 1;
    if (added !== null) stat.insertions += added;
    if (removed !== null) stat.deletions += removed;
    stat.paths.push(renameDestination(path));
  }
  return stat;
}

function renameDestination(path: string): string {
  const expanded = path.replace(/\{[^{}]* => ([^{}]*)\}/g, "$1");
  const arrow = expanded.lastIndexOf(" => ");
  return arrow < 0 ? expanded : expanded.slice(arrow + 4);
}

function countField(field: string | undefined): number | null | undefined {
  if (field === undefined) return undefined;
  if (field === "-") return null;
  if (!/^\d+$/.test(field)) return undefined;
  return Number(field);
}

interface CapturedDiff {
  text: string;
  numstat: string;
  stat: DiffStat;
  changed: boolean;
  clipped: boolean;
}

async function captureDiff(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
): Promise<CapturedDiff> {
  const staged = await run(ctx, {
    argv: STAGE_ARGV,
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
  });
  if (staged.exitCode !== 0) {
    throw new TerminalJobError(
      `Could not stage the working tree for validation: \`${STAGE_ARGV.join(" ")}\` ` +
        `${problem(staged)}. The diff cannot be trusted, so nothing is claimed about it.`,
    );
  }

  const numstat = await run(ctx, {
    argv: NUMSTAT_ARGV,
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: options.diffMaxBytes,
  });
  const diff = await run(ctx, {
    argv: DIFF_ARGV,
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: options.diffMaxBytes,
  });
  const stat = parseNumstat(numstat.stdout);
  return {
    text: diff.stdout,
    numstat: numstat.stdout,
    stat,
    changed: stat.filesChanged > 0 || diff.stdout.trim().length > 0,
    clipped: diff.truncated,
  };
}

async function recordDiff(ctx: PhaseContext, diff: CapturedDiff): Promise<void> {
  const summary =
    `${plural(diff.stat.filesChanged, "file")} changed, ` +
    `+${diff.stat.insertions}/-${diff.stat.deletions}`;
  await ctx.artifact({
    type: "diff",
    content: diff.text,
    metadata: {
      filesChanged: diff.stat.filesChanged,
      insertions: diff.stat.insertions,
      deletions: diff.stat.deletions,
      ...(diff.clipped ? { sandboxClipped: true } : {}),
    },
    message: diff.clipped
      ? `Recorded the working tree diff (${summary}). The sandbox's output cap clipped it, so ` +
        "the stored size understates the real one."
      : `Recorded the working tree diff (${summary}).`,
  });
  await ctx.artifact({
    type: "diff_stat",
    content: diff.numstat,
    metadata: {
      filesChanged: diff.stat.filesChanged,
      insertions: diff.stat.insertions,
      deletions: diff.stat.deletions,
    },
    message: `Recorded the diff stats: ${summary}.`,
  });
}

async function readTrackedFiles(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
): Promise<string[]> {
  const result = await run(ctx, {
    argv: TRACKED_ARGV,
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: options.diffMaxBytes,
  });
  if (result.exitCode !== 0 || result.truncated) {
    throw new TerminalJobError(
      `Could not read the staged tracked-file list: \`${TRACKED_ARGV.join(" ")}\` ${problem(result)}.`,
    );
  }
  return splitLines(result.stdout);
}

async function prepareReporterDirectory(
  ctx: PhaseContext,
  options: PipelineOptions,
): Promise<boolean> {
  const directory = `${options.workdir}/validation`;
  const result = await run(ctx, {
    argv: ["mkdir", "-p", directory],
    cwd: options.workdir,
    timeoutMs: options.commandTimeoutMs,
  });
  if (result.exitCode === 0) return true;
  ctx.log.warn(
    { directory, exitCode: result.exitCode },
    "reporter directory could not be prepared; running validation without reporter output",
  );
  return false;
}

function needsReporterDirectory(
  resolved: ResolvedValidation,
  selection: TargetedTestSelection,
): boolean {
  const fullTestHasReporter = !("skipped" in resolved.test) && resolved.test.reporter !== undefined;
  const targetedHasReporter =
    "paths" in selection &&
    !("skipped" in resolved.targeted) &&
    resolved.targeted.reporter !== undefined;
  return fullTestHasReporter || targetedHasReporter;
}

async function executeChecks(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
  resolved: ResolvedValidation,
  selection: TargetedTestSelection,
  reporterDirectoryReady: boolean,
): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (const kind of CHECK_ORDER) {
    const config = kind === "targeted_test" ? resolved.targeted : resolved[kind];
    runs.push(
      await executeCheck(ctx, options, repoDir, kind, config, selection, reporterDirectoryReady),
    );
  }
  return runs;
}

async function executeCheck(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
  kind: CheckKind,
  config: ResolvedCheckConfig | ResolvedTargetedConfig,
  selection: TargetedTestSelection,
  reporterDirectoryReady: boolean,
): Promise<CheckRun> {
  if (kind === "targeted_test" && "skipped" in selection) {
    return skippedRun(kind, "skipped" in config ? "package_json" : config.source, selection.reason);
  }
  if ("skipped" in config) return skippedRun(kind, "package_json", config.reason);

  const selectedPaths = "paths" in selection ? selection.paths : [];
  const argv =
    kind === "targeted_test" && "appendPaths" in config && config.appendPaths
      ? [...config.argv, ...selectedPaths]
      : [...config.argv];
  const isTest = kind === "test" || kind === "targeted_test";
  return runCheck(ctx, {
    kind,
    source: config.source,
    argv,
    cwd: repoDir,
    timeoutMs: config.timeoutMs ?? (isTest ? options.baselineTimeoutMs : options.checkTimeoutMs),
    ...(argv[0] === "corepack" ? { env: COREPACK_ENV } : {}),
    ...(isTest && config.reporter && reporterDirectoryReady
      ? {
          reporter: {
            ...config.reporter,
            outputPath: `${options.workdir}/validation/after-${kind}.json`,
            readMaxBytes: options.validationReportMaxBytes,
          },
        }
      : {}),
  });
}

function skippedRun(kind: CheckKind, source: CheckRun["source"], reason: string): CheckRun {
  return { kind, status: "skipped", source, reason };
}

function compareChecks(
  runs: CheckRun[],
  report: BaselineReport | null,
  legacyBaseline: BaselineOutcome | null,
): CheckComparison[] {
  return runs.map((after) => {
    const before = report?.checks.find((check) => check.kind === after.kind);
    const baseline = before?.status ?? (after.kind === "test" ? legacyBaseline : null);
    const attribution =
      after.kind === "test" && before?.tests?.parsed === true && after.tests?.parsed === true
        ? attribute(before.tests, after.tests)
        : undefined;
    const outcome =
      after.kind === "test" && attribution && attribution.newFailures.length > 0
        ? "regressed"
        : validationOutcome(baseline, after.status);
    return {
      ...after,
      baseline,
      outcome,
      ...(attribution === undefined ? {} : { attribution }),
    };
  });
}

async function recordCheck(
  ctx: PhaseContext,
  check: CheckComparison,
  targetedPaths: string[] | undefined,
): Promise<void> {
  await ctx.event({
    type: "validation.check_recorded",
    message: `Validation ${check.kind} ${check.outcome}.`,
    data: {
      check: check.kind,
      checkStatus: check.status,
      checkOutcome: check.outcome,
      ...(check.argv === undefined ? {} : { argv: check.argv }),
      ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
      ...(check.durationMs === undefined ? {} : { durationMs: check.durationMs }),
      ...(check.commandId === undefined ? {} : { commandId: check.commandId }),
      ...(check.tests === undefined
        ? {}
        : { testsTotal: check.tests.total, testsFailed: check.tests.failed }),
      ...(check.attribution === undefined
        ? {}
        : {
            newFailures: check.attribution.newFailures.length,
            preExistingFailures: check.attribution.preExistingFailures.length,
            fixedFailures: check.attribution.fixedFailures.length,
          }),
      ...(check.kind === "targeted_test" && targetedPaths !== undefined ? { targetedPaths } : {}),
    },
  });
}

function isBindingFailure(check: CheckComparison): boolean {
  if (check.kind === "targeted_test") return false;
  if (check.kind === "test") {
    return check.outcome === "regressed" || check.outcome === "unresolved";
  }
  return check.outcome === "regressed";
}

function describeOutcome(outcome: ValidationOutcome, test: CheckComparison | undefined): string {
  const suite = test?.argv ? `\`${test.argv.join(" ")}\`` : "the test suite";
  switch (outcome) {
    case "verified":
      return `Verified: ${suite} passed before the change and passes after it.`;
    case "fixed":
      return `Fixed: ${suite} was failing before the change and passes after it.`;
    case "regressed":
      return `Regressed: validation found a newly failing binding check.`;
    case "unresolved":
      return `Unresolved: ${suite} was failing before the change and still fails.`;
    case "unverified":
      return "Unverified: validation had no comparable binding baseline.";
  }
}

function describeFailure(check: CheckComparison): string {
  const names = check.attribution?.newFailures ?? [];
  const named = names.length === 0 ? "" : ` New failures: ${names.join(", ")}.`;
  return `Validation failed because ${check.kind} ${check.outcome}.${named} The diff is kept so the failure can be read.`;
}

async function run(
  ctx: PhaseContext,
  input: Parameters<PhaseContext["exec"]>[0],
): Promise<RecordedCommand> {
  const result = await ctx.exec(input);
  ctx.signal.throwIfAborted();
  const killed = commandKilledError(result);
  if (killed) throw killed;
  return result;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
