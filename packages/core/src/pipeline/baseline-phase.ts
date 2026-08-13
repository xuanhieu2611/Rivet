import { commandKilledError } from "../sandbox/errors";
import { problem, splitLines } from "./command-output";
import type { PhaseContext, PhaseExecInput, RecordedCommand } from "./phase-context";
import type { PipelineOptions } from "./phases";
import { detectPackageManager, type ProjectPlan, readScript, REPO_DIRNAME } from "./project";

/**
 * Phase five: run the repository's own tests before Rivet has changed anything.
 *
 * The one place in this milestone where the obvious behaviour is the wrong one.
 * **A non-zero exit here does not fail the job.** PRD §11 C asks for exactly
 * this: establish whether the repository is already healthy *before* modifying
 * it, so that a pre-existing failure is never attributed to the agent. A red
 * baseline is a recorded property of the repository that Milestone 5 compares
 * its own run against; treating it as a job failure would make Rivet unable to
 * work on precisely the repositories it is most useful for.
 *
 * What *does* fail the job is the command being killed - a timeout or an OOM -
 * because those are facts about the sandbox rather than about the repository.
 * That asymmetry is the whole design of this file, and it is why the sandbox
 * port reports a non-zero exit as a result and a kill as a flag: the exit code
 * means whatever the phase running the command says it means, and here it means
 * almost nothing.
 *
 * Deliberately not here: typecheck and lint runs, and per-repository validation
 * configuration. That is Milestone 7, and adding it now would mean guessing at a
 * config format before there is a consumer for it.
 */

/**
 * The manifest is read with a cap of its own, well above the default.
 *
 * The default output cap is tuned for transcripts, and a `package.json` clipped
 * at 64KB is not a smaller manifest - it is invalid JSON. A repository with a
 * manifest bigger than this exists, but it does not exist yet.
 */
const MANIFEST_MAX_BYTES = 1_048_576;

/** The script this milestone knows to look for. Per-repo config is Milestone 7. */
const BASELINE_SCRIPT = "test";

export function baselinePhase(options: PipelineOptions): (ctx: PhaseContext) => Promise<void> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;

  return async function baseline(ctx: PhaseContext): Promise<void> {
    const plan = await readProject(ctx, options, repoDir);
    if (!plan) return;

    const command = plan.runScript(BASELINE_SCRIPT);
    const result = await ctx.exec({
      argv: command,
      cwd: repoDir,
      // Its own budget rather than the ordinary per-command one. A test suite
      // that takes four minutes is a slow suite, not a hung sandbox, and
      // reporting it as `command_timed_out` would be Rivet calling a normal
      // repository broken.
      timeoutMs: options.baselineTimeoutMs,
      ...(plan.env ? { env: plan.env } : {}),
    });

    // Order matters here for the same reason it does in `provisioning`: a
    // cancelled job kills the container mid-command, and every command in a
    // killed container comes back looking like a failing test suite.
    ctx.signal.throwIfAborted();
    const killed = commandKilledError(result);
    if (killed) throw killed;

    const passed = result.exitCode === 0;
    await ctx.event({
      type: "baseline.recorded",
      message: passed
        ? `Baseline is green: \`${command.join(" ")}\` passed.`
        : `Baseline is red: \`${command.join(" ")}\` ${problem(result)}. Recorded, not failed - ` +
          `the repository was already like this.`,
      data: {
        baseline: passed ? "passed" : "failed",
        argv: result.argv,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        commandId: result.commandId,
      },
    });

    if (!passed) {
      ctx.log.info(
        { exitCode: result.exitCode, argv: command },
        "baseline suite is failing before any change; recorded as a property of the repository",
      );
    }
  };
}

/**
 * Works out what to run, or records why there is nothing to.
 *
 * Returns `null` for every "there is no baseline to establish" answer, having
 * already written the event that says so. None of those are job failures: a
 * repository with no tests is not a broken job, and neither is one whose
 * manifest this milestone could not make sense of after an install that
 * plainly could. The reason is on the timeline either way.
 *
 * The package manager is re-detected here rather than carried over from
 * `provisioning`. One cheap `ls` beats threading state between phases through a
 * column another phase wrote, and it keeps this phase runnable on its own -
 * which is what Milestone 6 will need when it resumes a job into an existing
 * sandbox.
 */
async function readProject(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
): Promise<ProjectPlan | null> {
  const listing = await run(ctx, {
    argv: ["ls", "-1", "-a", repoDir],
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
  });
  guard(ctx, listing);

  const plan = listing.exitCode === 0 ? detectPackageManager(splitLines(listing.stdout)) : null;
  if (!plan) {
    return skip(ctx, `Could not read the repository root, so no baseline was established.`);
  }

  const manifest = await run(ctx, {
    argv: ["cat", "package.json"],
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: MANIFEST_MAX_BYTES,
  });
  guard(ctx, manifest);

  if (manifest.exitCode !== 0 || manifest.truncated) {
    return skip(ctx, `Could not read package.json, so no baseline was established.`);
  }

  const script = parseManifest(manifest.stdout);
  if (script === undefined) {
    return skip(ctx, `package.json is not readable as JSON, so no baseline was established.`);
  }
  if (script === null) {
    return skip(
      ctx,
      `No \`${BASELINE_SCRIPT}\` script in package.json; there is no baseline to establish.`,
    );
  }

  return plan;
}

/**
 * `undefined` for unparseable, `null` for absent, the script otherwise.
 *
 * Three answers rather than two because they are three different facts, and the
 * timeline says which. Note that unparseable should be impossible here - the
 * install in `provisioning` already read this file successfully - so it means
 * something stranger than a bad manifest, and it still is not worth failing a
 * job over.
 */
function parseManifest(text: string): string | null | undefined {
  try {
    return readScript(JSON.parse(text), BASELINE_SCRIPT);
  } catch {
    return undefined;
  }
}

/** Records that there is no baseline, and why. Always returns `null`. */
async function skip(ctx: PhaseContext, message: string): Promise<null> {
  await ctx.event({ type: "baseline.recorded", message, data: { baseline: "skipped" } });
  ctx.log.info({ reason: message }, "no baseline established");
  return null;
}

/** One command, recorded whatever it did. */
function run(ctx: PhaseContext, input: PhaseExecInput): Promise<RecordedCommand> {
  return ctx.exec(input);
}

/**
 * Stops the phase for the two things that are the sandbox's fault.
 *
 * Everything else about a command in this phase is information rather than
 * failure, so this deliberately says nothing about exit codes.
 */
function guard(ctx: PhaseContext, result: RecordedCommand): void {
  ctx.signal.throwIfAborted();
  const killed = commandKilledError(result);
  if (killed) throw killed;
}
