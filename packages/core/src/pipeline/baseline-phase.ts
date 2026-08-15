import { serializeBaselineReport, type CheckRun } from "@rivet/contracts";

import { commandKilledError } from "../sandbox/errors";
import type { PhaseContext } from "./phase-context";
import type { PipelineOptions } from "./phases";
import type { PhaseDirective } from "./run-pipeline";
import { probeValidation } from "./project-probe";
import { COREPACK_ENV, REPO_DIRNAME } from "./project";
import { runCheck } from "./check-runner";
import type { ResolvedCheckConfig } from "./validation-config";

/** Kept until the legacy single-suite validation phase no longer imports it. */
export const BASELINE_SCRIPT = "test";

const BASELINE_CHECKS = ["test", "typecheck", "lint"] as const;

/**
 * Phase two: establish every deterministic repository check before any edit.
 *
 * A non-zero exit is a property of the repository, not a failed job. Commands
 * that were killed still escape through `runCheck`, because a timeout or OOM is
 * a sandbox failure rather than a red baseline. Every runnable check is attempted
 * in the fixed test, typecheck, lint order so one red check cannot hide another.
 *
 * The legacy `baseline.recorded` row remains the durable compatibility boundary
 * for M5 and M6 readers. It describes only the test check and keeps its original
 * data shape. The complete check set and parsed failure names live in the
 * canonical `baseline_report` artifact.
 */
export function baselinePhase(
  options: PipelineOptions,
): (ctx: PhaseContext) => Promise<PhaseDirective> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;

  return async function baseline(ctx: PhaseContext): Promise<PhaseDirective> {
    const resolved = await probeValidation(ctx, {
      repoDir,
      commandTimeoutMs: options.commandTimeoutMs,
    });
    const reporterDirectoryReady =
      "skipped" in resolved.test || resolved.test.reporter === undefined
        ? false
        : await prepareReporterDirectory(ctx, options);
    const checks: CheckRun[] = [];

    for (const kind of BASELINE_CHECKS) {
      const check = await executeBaselineCheck(
        ctx,
        options,
        repoDir,
        kind,
        resolved[kind],
        reporterDirectoryReady,
      );
      checks.push(check);
      await recordCheck(ctx, check);
    }

    const test = checks[0];
    if (test?.kind !== "test") {
      throw new Error("Baseline check order did not produce the required test result.");
    }

    await recordLegacyBaseline(ctx, test);
    await ctx.artifact({
      type: "baseline_report",
      content: serializeBaselineReport({ checks }),
      requireComplete: true,
      message: "Baseline report artifact recorded.",
    });

    // Nothing to ask the runner for: the queue carries on. See `PhaseDirective`.
    return undefined;
  };
}

async function executeBaselineCheck(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
  kind: (typeof BASELINE_CHECKS)[number],
  config: ResolvedCheckConfig,
  reporterDirectoryReady: boolean,
): Promise<CheckRun> {
  if ("skipped" in config) {
    return {
      kind,
      status: "skipped",
      // A skip means the inference path found no runnable command. rivet.json
      // has no explicit disabled form, so package_json is the truthful source.
      source: "package_json",
      reason: config.reason,
    };
  }

  return runCheck(ctx, {
    kind,
    source: config.source,
    argv: config.argv,
    cwd: repoDir,
    timeoutMs:
      config.timeoutMs ?? (kind === "test" ? options.baselineTimeoutMs : options.checkTimeoutMs),
    ...(config.argv[0] === "corepack" ? { env: COREPACK_ENV } : {}),
    ...(kind === "test" && config.reporter && reporterDirectoryReady
      ? {
          reporter: {
            ...config.reporter,
            outputPath: `${options.workdir}/validation/baseline-${kind}.json`,
            readMaxBytes: options.validationReportMaxBytes,
          },
        }
      : {}),
  });
}

/**
 * Creates Rivet's reporter directory without letting instrumentation decide the
 * check result. An unavailable directory disables parsing for this phase; the
 * repository command still runs unchanged. Cancellation remains authoritative.
 */
async function prepareReporterDirectory(
  ctx: PhaseContext,
  options: PipelineOptions,
): Promise<boolean> {
  const directory = `${options.workdir}/validation`;
  ctx.signal.throwIfAborted();
  const result = await ctx.exec({
    argv: ["mkdir", "-p", directory],
    cwd: options.workdir,
    timeoutMs: options.commandTimeoutMs,
  });
  ctx.signal.throwIfAborted();
  const killed = commandKilledError(result);
  if (killed) throw killed;

  if (result.exitCode === 0) return true;
  ctx.log.warn(
    { directory, exitCode: result.exitCode },
    "reporter directory could not be prepared; running baseline without reporter output",
  );
  return false;
}

async function recordCheck(ctx: PhaseContext, check: CheckRun): Promise<void> {
  await ctx.event({
    type: "baseline.check_recorded",
    message: describeCheck(check),
    data: {
      check: check.kind,
      checkStatus: check.status,
      ...(check.argv === undefined ? {} : { argv: check.argv }),
      ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
      ...(check.durationMs === undefined ? {} : { durationMs: check.durationMs }),
      ...(check.commandId === undefined ? {} : { commandId: check.commandId }),
      ...(check.tests === undefined
        ? {}
        : { testsTotal: check.tests.total, testsFailed: check.tests.failed }),
    },
  });
}

function describeCheck(check: CheckRun): string {
  if (check.status === "skipped") {
    return `Baseline ${check.kind} skipped: ${check.reason}.`;
  }
  return `Baseline ${check.kind} ${check.status}: \`${check.argv?.join(" ")}\` exited ${check.exitCode}.`;
}

/** Writes the unchanged M5 event shape from the test check only. */
async function recordLegacyBaseline(ctx: PhaseContext, test: CheckRun): Promise<void> {
  if (test.status === "skipped") {
    const message = `No baseline was established: ${test.reason}.`;
    await ctx.event({ type: "baseline.recorded", message, data: { baseline: "skipped" } });
    ctx.log.info({ reason: message }, "no baseline established");
    return;
  }

  const command = test.argv;
  const { exitCode, durationMs, commandId } = test;
  if (
    command === undefined ||
    exitCode === undefined ||
    durationMs === undefined ||
    commandId === undefined
  ) {
    throw new Error("A completed baseline test check is missing command details.");
  }
  await ctx.event({
    type: "baseline.recorded",
    message:
      test.status === "passed"
        ? `Baseline is green: \`${command.join(" ")}\` passed.`
        : `Baseline is red: \`${command.join(" ")}\` exit ${test.exitCode}. Recorded, not failed - ` +
          `the repository was already like this.`,
    data: {
      baseline: test.status,
      argv: command,
      exitCode,
      durationMs,
      commandId,
    },
  });

  if (test.status === "failed") {
    ctx.log.info(
      { exitCode: test.exitCode, argv: command },
      "baseline suite is failing before any change; recorded as a property of the repository",
    );
  }
}
