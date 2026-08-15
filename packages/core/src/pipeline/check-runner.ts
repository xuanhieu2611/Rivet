import { posix } from "node:path";

import type { CheckKind, CheckRun, CheckSource, TestFramework, TestReport } from "@rivet/contracts";

import { commandKilledError } from "../sandbox/errors";
import type { PhaseContext } from "./phase-context";
import { parseJestJson, parseVitestJson, reporterArgs } from "./test-report";

export interface CheckReporterOptions {
  framework: TestFramework;
  outputPath: string;
  readMaxBytes: number;
  outputArg?: string;
}

export interface RunCheckInput {
  kind: CheckKind;
  source: CheckSource;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  reporter?: CheckReporterOptions;
}

/**
 * Runs one repository check through the phase context and shapes its durable result.
 *
 * Reporter output is an optional reporting improvement. A missing, truncated, or
 * malformed file never changes the command's exit-based status and never fails the
 * job. Command execution itself stays on `ctx.exec`, preserving the ordinary command
 * transcript and lifecycle events.
 */
export async function runCheck(ctx: PhaseContext, input: RunCheckInput): Promise<CheckRun> {
  const suffix =
    input.reporter && isOutsideRepository(input.cwd, input.reporter.outputPath)
      ? reporterArgs(
          {
            framework: input.reporter.framework,
            ...(input.reporter.outputArg === undefined
              ? {}
              : { outputArg: input.reporter.outputArg }),
          },
          input.reporter.outputPath,
        )
      : null;
  const argv = suffix === null ? [...input.argv] : [...input.argv, ...suffix];
  const result = await ctx.exec({
    argv,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    ...(input.env === undefined ? {} : { env: input.env }),
  });

  // A cancellation kills the sandbox and makes its active command look like a
  // failed check. Preserve cancellation as the authoritative reason first.
  ctx.signal.throwIfAborted();
  const killed = commandKilledError(result);
  if (killed) throw killed;

  const tests =
    input.reporter && suffix !== null
      ? await readReporterBestEffort(ctx, input.reporter)
      : undefined;

  return {
    kind: input.kind,
    status: result.exitCode === 0 ? "passed" : "failed",
    source: input.source,
    argv: [...result.argv],
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    commandId: result.commandId,
    ...(tests === undefined ? {} : { tests }),
  };
}

function isOutsideRepository(repositoryDir: string, outputPath: string): boolean {
  if (!posix.isAbsolute(repositoryDir) || !posix.isAbsolute(outputPath)) return false;
  const relative = posix.relative(repositoryDir, outputPath);
  return relative === ".." || relative.startsWith("../");
}

async function readReporterBestEffort(
  ctx: PhaseContext,
  reporter: CheckReporterOptions,
): Promise<TestReport | undefined> {
  try {
    const file = await ctx.sandboxes
      .require()
      .getFile(reporter.outputPath, { maxBytes: reporter.readMaxBytes }, ctx.signal);
    ctx.signal.throwIfAborted();
    if (file.truncated) return undefined;

    const parsed =
      reporter.framework === "vitest" ? parseVitestJson(file.content) : parseJestJson(file.content);
    return parsed.parsed ? parsed : undefined;
  } catch {
    // Do not turn cancellation into a reporter degradation. File-system and
    // parser failures are best-effort, but the job signal remains authoritative.
    ctx.signal.throwIfAborted();
    return undefined;
  }
}
