import { commandKilledError } from "../sandbox/errors";
import { problem } from "./command-output";
import type { PhaseContext } from "./phase-context";
import type { PipelineOptions } from "./phases";
import { probeProject } from "./project-probe";
import { REPO_DIRNAME } from "./project";

/**
 * Phase two: run the repository's own tests before Rivet has changed anything.
 *
 * "Before" is load-bearing and used not to be true. Until Milestone 5 this body
 * was wired to `testing`, which runs *after* `implementing`, so the phase whose
 * entire premise is "was this repository already broken" was measuring a tree
 * the coding session had just edited. It now runs at `analyzing`, ahead of every
 * phase that can change a file, and `testing` re-runs the same suite and
 * compares the two.
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
 * The script this milestone knows to look for. Per-repo config is Milestone 7.
 *
 * Exported because `testing` has to re-run exactly this one for its comparison
 * to mean anything, and two phases naming the same string separately is how they
 * stop naming the same string.
 */
export const BASELINE_SCRIPT = "test";

export function baselinePhase(options: PipelineOptions): (ctx: PhaseContext) => Promise<void> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;

  return async function baseline(ctx: PhaseContext): Promise<void> {
    const probe = await probeProject(ctx, {
      repoDir,
      commandTimeoutMs: options.commandTimeoutMs,
      script: BASELINE_SCRIPT,
    });
    if (!probe.plan) {
      await skip(ctx, `No baseline was established: ${probe.reason}.`);
      return;
    }

    const plan = probe.plan;
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

/** Records that there is no baseline, and why. Never a job failure. */
async function skip(ctx: PhaseContext, message: string): Promise<void> {
  await ctx.event({ type: "baseline.recorded", message, data: { baseline: "skipped" } });
  ctx.log.info({ reason: message }, "no baseline established");
}
