import type { ValidationOutcome } from "@rivet/contracts";

import type { BaselineOutcome } from "../events/baseline-log";
import { NoChangesProducedError, TerminalJobError, ValidationFailedError } from "../jobs/failure";
import { commandKilledError } from "../sandbox/errors";
import { BASELINE_SCRIPT } from "./baseline-phase";
import { problem } from "./command-output";
import type { PhaseContext, RecordedCommand } from "./phase-context";
import type { PipelineOptions } from "./phases";
import { probeProject } from "./project-probe";
import { REPO_DIRNAME } from "./project";

/**
 * Phase five: form an opinion about what the session actually did.
 *
 * Milestone 4 could run a model, record every turn it took and bill it. What it
 * could not do was disagree with it. A session ends, the job goes green, and
 * nothing anywhere has asked whether the repository is better than it was. This
 * phase is that question, and it answers it in the only way that is worth
 * anything: by re-running the repository's own test suite - the same script
 * `analyzing` ran, resolved through the same `probeProject` - and comparing.
 *
 * Two facts make the comparison meaningful rather than decorative.
 *
 * **The baseline is what gives the second run its meaning.** A red suite after
 * the session is a regression if the suite was green before and an unfinished
 * job if it was red, and those are different sentences on a dashboard. The
 * baseline is read back out of the event log rather than passed in memory, so
 * this phase works the same way when Milestone 6 resumes a job in a new process.
 *
 * **The diff is captured first, before anything can fail.** A job that fails
 * validation, or is cancelled between the session and its conclusion, still
 * produced work, and the evidence of what the model did is the single most
 * valuable thing to keep from a run that went wrong. Capturing it as the first
 * act of this phase means the artifact exists on every path that reaches
 * `testing` at all. `finalizing` persists the summary and does not touch the
 * diff again.
 *
 * What this phase deliberately is not is a repair loop. PRD §31 M5 asks for one
 * implementation session and PRD §14 says not to duplicate the harness's own
 * context management, so failure observation and iterative debugging happen
 * inside the session's `bash` turns - `implementing` tells the model the
 * baseline and names this exact command for that reason. Rivet checks the answer
 * once. If the deterministic check disagrees with the model, the job fails and
 * says why, which is a more honest milestone than a retry loop that hides a bad
 * session behind a second one.
 */

/**
 * A diff, not a commit, and not a branch.
 *
 * `git add -A` then `git diff --cached` against the depth-1 clone's HEAD, which
 * is `base_commit_sha`. No commit is created and no git identity is configured
 * inside the container: Milestone 9 owns identity, branch, commit and push, and
 * inventing half of that interface now would leave it with a consumer nobody
 * designed for.
 *
 * `--cached` rather than a plain `git diff` because staging is what makes new
 * files visible - an untracked file is absent from an unstaged diff, and a
 * session that solved its task by adding a module would look like a session that
 * did nothing. `git add -A` respects `.gitignore`, which is the whole reason the
 * fixture repository has one.
 */
const STAGE_ARGV = ["git", "add", "-A"];
const DIFF_ARGV = ["git", "diff", "--cached"];

/**
 * `--numstat` rather than `--stat`, and it is not a style preference.
 *
 * `--stat` is a display format tuned for a terminal width: it abbreviates paths,
 * scales its bar graph, and has changed its output before. `--numstat` is
 * machine-readable by construction - three tab-separated fields per file, no
 * width, no ellipsis - which is the difference between parsing a contract and
 * parsing a rendering.
 */
const NUMSTAT_ARGV = ["git", "diff", "--cached", "--numstat"];

export function validationPhase(options: PipelineOptions): (ctx: PhaseContext) => Promise<void> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;

  return async function validate(ctx: PhaseContext): Promise<void> {
    const diff = await captureDiff(ctx, options, repoDir);

    // The most interesting failure this milestone can surface, and the reason
    // it is checked before the suite is ever re-run: a session that ended with
    // `stopReason: completed` having changed nothing did not do the task while
    // believing it had, and re-running a suite that is bit-for-bit the baseline
    // would only tell us what `analyzing` already said.
    if (!diff.changed) {
      throw new NoChangesProducedError(
        "The coding session finished without changing anything: `git diff --cached` is empty " +
          "against the commit the repository was cloned at. There is nothing to validate and " +
          "nothing to keep.",
      );
    }

    await recordDiff(ctx, diff);

    const baseline = await ctx.readBaseline();
    const after = await runSuite(ctx, options, repoDir);
    const outcome = validationOutcome(baseline, after.result);

    await ctx.event({
      type: "validation.recorded",
      message: describeOutcome(outcome, baseline, after),
      data: {
        validation: outcome,
        ...(baseline ? { baseline } : {}),
        filesChanged: diff.stat.filesChanged,
        insertions: diff.stat.insertions,
        deletions: diff.stat.deletions,
        ...(after.command
          ? {
              argv: after.command.argv,
              exitCode: after.command.exitCode,
              durationMs: after.command.durationMs,
              commandId: after.command.commandId,
            }
          : {}),
      },
    });

    ctx.log.info(
      { outcome, baseline, ...diff.stat },
      "validation compared the suite against the baseline",
    );

    if (FAILING_OUTCOMES.includes(outcome)) {
      throw new ValidationFailedError(describeFailure(outcome, after));
    }
  };
}

/** The two outcomes that fail a job. Everything else is a green run. */
const FAILING_OUTCOMES: readonly ValidationOutcome[] = ["regressed", "unresolved"];

/** What re-running the suite established, before the baseline gives it meaning. */
export type SuiteResult = "passed" | "failed" | "skipped";

/**
 * The whole comparison, as a pure function.
 *
 * Deliberately separated from everything that needs a container, a database or a
 * model, because this table *is* the milestone and it should be provable as a
 * matrix rather than as a run:
 *
 * | baseline  | after  | outcome      | job    |
 * | --------- | ------ | ------------ | ------ |
 * | `passed`  | passes | `verified`   | green  |
 * | `passed`  | fails  | `regressed`  | failed |
 * | `failed`  | passes | `fixed`      | green  |
 * | `failed`  | fails  | `unresolved` | failed |
 * | `skipped` | n/a    | `unverified` | green  |
 *
 * `unverified` stays green on purpose. A repository with no `test` script is not
 * a broken job, and failing it would repeat exactly the mistake PRD §11 C exists
 * to prevent - Rivet refusing to work on the repositories it is most useful for.
 * It is recorded rather than omitted so that nobody reads a green badge as a
 * claim that was checked.
 *
 * A null baseline collapses into `unverified` for the same reason and is not the
 * same fact as `skipped`: null means nobody looked - a job resumed straight into
 * `implementing`, or a database hiccup reading the event back - where `skipped`
 * means `analyzing` looked and found nothing runnable. Neither supports an
 * attribution, and attributing a failure nobody can source to the session is the
 * one thing this milestone must not do.
 */
export function validationOutcome(
  baseline: BaselineOutcome | null,
  after: SuiteResult,
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

/** The parsed totals of a `--numstat`, which is also the `diff_stat` metadata. */
export interface DiffStat {
  /**
   * Every changed path, including binary ones.
   *
   * Counted separately from the line totals because `--numstat` reports `-` for
   * a binary file rather than a number: a diff of one PNG is one file and zero
   * lines, which is the honest reading of what git actually said.
   */
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * Reads `git diff --cached --numstat` into three numbers.
 *
 * Tolerant of every line that is not a numstat row - git prints warnings to
 * stdout under some configurations, and a `warning: LF will be replaced` line
 * counted as a changed file would quietly inflate every stat this phase records.
 * A row is three tab-separated fields whose first two are each a number or `-`,
 * and anything else is ignored rather than guessed at.
 *
 * Renames arrive as `1\t1\tsrc/{old.js => new.js}` and are deliberately counted
 * as the one file git says they are.
 */
export function parseNumstat(text: string): DiffStat {
  const stat: DiffStat = { filesChanged: 0, insertions: 0, deletions: 0 };

  for (const line of text.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;

    const added = countField(fields[0]);
    const removed = countField(fields[1]);
    if (added === undefined || removed === undefined) continue;
    if (fields.slice(2).join("\t").trim().length === 0) continue;

    stat.filesChanged += 1;
    if (added !== null) stat.insertions += added;
    if (removed !== null) stat.deletions += removed;
  }

  return stat;
}

/** A count, `null` for the `-` a binary file gets, `undefined` for not a row at all. */
function countField(field: string | undefined): number | null | undefined {
  if (field === undefined) return undefined;
  if (field === "-") return null;
  if (!/^\d+$/.test(field)) return undefined;
  return Number(field);
}

interface CapturedDiff {
  text: string;
  /** The raw `--numstat` output, which is the per-file breakdown nothing else keeps. */
  numstat: string;
  stat: DiffStat;
  /** False only when the working tree is identical to the commit it was cloned at. */
  changed: boolean;
  /** True when the sandbox's own output cap clipped the diff before it was stored. */
  clipped: boolean;
}

/**
 * Stages the working tree and reads what changed, in three commands.
 *
 * Read through `ctx.exec` like everything else, so the staging and the two reads
 * are on the timeline with their transcripts, exactly as the session's own
 * commands are.
 */
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

  // The one command here whose non-zero exit is fatal, and it is fatal for a
  // specific reason: an unstaged tree produces an empty `git diff --cached`, so
  // continuing would report `no_changes_produced` for a session that may well
  // have changed a great deal. A wrong answer about the work is worse than no
  // answer about it.
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
    // Its own cap, well above the artifact bound, so that truncation and
    // `byte_size` are decided by `recordArtifact` rather than by the container's
    // transcript limit. A diff clipped on the way out would record the clipped
    // size as its true one, which is the exact thing that column exists to
    // prevent.
    maxOutputBytes: options.diffMaxBytes,
  });

  const stat = parseNumstat(numstat.stdout);
  return {
    text: diff.stdout,
    numstat: numstat.stdout,
    stat,
    // Either witness is enough. A mode-only change is `0\t0\tpath` in the
    // numstat and a header-only hunk in the diff, and both are changes.
    changed: stat.filesChanged > 0 || diff.stdout.trim().length > 0,
    clipped: diff.truncated,
  };
}

/** Persists the diff and its stats, in that order, as two artifacts. */
async function recordDiff(ctx: PhaseContext, diff: CapturedDiff): Promise<void> {
  const summary =
    `${plural(diff.stat.filesChanged, "file")} changed, ` +
    `+${diff.stat.insertions}/-${diff.stat.deletions}`;

  await ctx.artifact({
    type: "diff",
    content: diff.text,
    metadata: { ...diff.stat, ...(diff.clipped ? { sandboxClipped: true } : {}) },
    message: diff.clipped
      ? `Recorded the working tree diff (${summary}). The sandbox's output cap clipped it, so ` +
        `the stored size understates the real one.`
      : `Recorded the working tree diff (${summary}).`,
  });

  await ctx.artifact({
    type: "diff_stat",
    // The raw `--numstat` rather than the parsed totals: the totals are on the
    // row's metadata and on the event, and the per-file breakdown is the thing
    // neither of those can hold.
    content: diff.numstat,
    metadata: { ...diff.stat },
    message: `Recorded the diff stats: ${summary}.`,
  });
}

interface SuiteRun {
  result: SuiteResult;
  /** Absent when there was no script to run, which is the `skipped` case. */
  command?: RecordedCommand;
  /** Why nothing was run, present exactly when `command` is absent. */
  reason?: string;
}

/**
 * Re-runs the script the baseline ran, and interprets its exit code.
 *
 * The same asymmetry `baselinePhase` establishes, and for the same reason: a
 * killed command - a timeout, an OOM - is a fact about the sandbox and fails the
 * job outright, where a non-zero exit is a fact this phase is here to interpret.
 * The exit code means whatever the phase running the command says it means, and
 * here it means one column of the outcome table.
 */
async function runSuite(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
): Promise<SuiteRun> {
  const probe = await probeProject(ctx, {
    repoDir,
    commandTimeoutMs: options.commandTimeoutMs,
    script: BASELINE_SCRIPT,
  });
  if (!probe.plan) {
    return { result: "skipped", reason: probe.reason ?? "there is nothing to run" };
  }

  const command = await run(ctx, {
    argv: probe.plan.runScript(BASELINE_SCRIPT),
    cwd: repoDir,
    // The baseline's budget, not the ordinary one, because it is the same suite:
    // a four-minute run that was allowed to be slow before must be allowed to be
    // slow now, or the comparison would fail on the clock rather than on the
    // code.
    timeoutMs: options.baselineTimeoutMs,
    ...(probe.plan.env ? { env: probe.plan.env } : {}),
  });

  return { result: command.exitCode === 0 ? "passed" : "failed", command };
}

/** One command, with the two kills that stop this phase raised as errors. */
async function run(
  ctx: PhaseContext,
  input: Parameters<PhaseContext["exec"]>[0],
): Promise<RecordedCommand> {
  const result = await ctx.exec(input);
  // Order matters, exactly as it does in `analyzing`: a cancelled job kills the
  // container mid-command, and every command in a killed container comes back
  // looking like a failing test suite.
  ctx.signal.throwIfAborted();
  const killed = commandKilledError(result);
  if (killed) throw killed;
  return result;
}

/** The timeline line, which states the comparison rather than the exit code. */
function describeOutcome(
  outcome: ValidationOutcome,
  baseline: BaselineOutcome | null,
  after: SuiteRun,
): string {
  const suite = after.command ? `\`${after.command.argv.join(" ")}\`` : "the test suite";

  switch (outcome) {
    case "verified":
      return `Verified: ${suite} passed before the change and passes after it.`;
    case "fixed":
      return `Fixed: ${suite} was failing before the change and passes after it.`;
    case "regressed":
      return (
        `Regressed: ${suite} passed before the change and now ` +
        `${after.command ? problem(after.command) : "fails"}.`
      );
    case "unresolved":
      return (
        `Unresolved: ${suite} was failing before the change and still ` +
        `${after.command ? problem(after.command) : "fails"}.`
      );
    case "unverified":
      return baseline === null || baseline === "skipped"
        ? `Unverified: there was no baseline to compare against` +
            `${after.reason ? `, and ${after.reason}` : ""}. The change is recorded but nothing ` +
            `was checked.`
        : `Unverified: ${after.reason ?? "the suite could not be re-run"}, so the change is ` +
            `recorded but nothing was checked.`;
  }
}

/** What lands in `failure_reason`, which is what a dashboard shows. */
function describeFailure(outcome: ValidationOutcome, after: SuiteRun): string {
  const suite = after.command ? `\`${after.command.argv.join(" ")}\`` : "the test suite";
  const detail = after.command ? ` (${problem(after.command)})` : "";

  return outcome === "regressed"
    ? `The change broke a suite that was green: ${suite} passed before the session and fails ` +
        `after it${detail}. The diff is kept so the regression can be read.`
    : `The change did not fix the suite: ${suite} was failing before the session and is still ` +
        `failing after it${detail}. The diff is kept so the attempt can be read.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
