import type { CheckComparison, ValidationOutcome, ValidationReport } from "@rivet/contracts";

import type { ValidationRecord } from "../events/validation-log";
import type { PhaseContext } from "./phase-context";
import type { PhaseDirective } from "./run-pipeline";

/**
 * Phase seven: keep what the session said, and say what the run came to.
 *
 * Deliberately the smallest real phase in the pipeline, and both halves of it
 * are about the run being readable afterwards rather than about doing more work.
 *
 * The first half persists the session's own account of its change as the
 * `implementation_summary` artifact. That text is the last thing the model said,
 * which `implementing` asks for explicitly in the task instructions; it is read
 * back out of the event log rather than handed over, because `runPipeline` is a
 * flat walk that passes nothing from one phase to the next and Milestone 6 will
 * resume a job into this phase in a process that never ran the session. See
 * `events/session-log.ts`.
 *
 * The second half writes the run's closing line, carrying the validation outcome
 * and the diff totals. Until now the last entry on a timeline was a phase saying
 * it had finished, which states that something happened without stating what: a
 * reader who scrolled to the bottom of a green job could not tell a `fixed` run
 * from an `unverified` one without going back up through the log for the
 * `validation.recorded` row. One event fixes that, and it is a different fact
 * from `job.completed` - the processor writes that one about the job reaching a
 * terminal status, and a run can be summarized and then fail to complete.
 *
 * What is deliberately **not** here is a branch, a commit, a push or a pull
 * request. That is PRD §11 I and belongs to Milestone 9, which owns git identity
 * inside the container; inventing half of that interface now would leave it with
 * a consumer nobody designed for. The sandbox is still alive at this point only
 * because the processor's `finally` destroys it after the pipeline returns, which
 * is what will let M9 fill this body rather than add a phase.
 */

/**
 * What the artifact says when the session left nothing to say.
 *
 * Some sessions end on a tool call, and the honest response is to record the
 * absence rather than to synthesize a summary from the diff. An invented one
 * would be indistinguishable from a real one on the way back out, which is the
 * only property that matters about a record of what a model claimed. The
 * artifact is still written so that "no summary" and "this phase never ran" stay
 * different facts.
 */
const ABSENT_SUMMARY =
  "The coding session ended without a closing message, so it left no account of what it " +
  "changed or why. Nothing has been written in its place: the diff artifact is the record " +
  "of what actually happened.";

/**
 * A closure over nothing, matching every other phase's export shape.
 *
 * Milestone 9 needs `PipelineOptions` here for the push timeouts, and changing
 * this file's export shape and its call site at the moment that work starts is
 * worse than an empty parameter list now - the same argument `planningPhase`
 * makes for Milestone 6.
 */
export function finalizingPhase(): (ctx: PhaseContext) => Promise<PhaseDirective> {
  return async function finalizing(ctx: PhaseContext): Promise<PhaseDirective> {
    ctx.signal.throwIfAborted();

    const summary = await ctx.readSummary();
    await ctx.artifact({
      type: "implementation_summary",
      content: summary ?? ABSENT_SUMMARY,
      // The one thing a reader cannot recover from the content itself, since
      // the absence is recorded as prose that looks like any other prose.
      metadata: { present: summary !== null },
      message: summary
        ? "Recorded the session's own account of what it changed."
        : "Recorded that the session ended without describing what it changed.",
    });

    const validation = await ctx.readValidation();
    const report = await ctx.readValidationReport();
    await ctx.event({
      type: "run.summarized",
      message: describeRun(validation, summary !== null, report),
      data: {
        ...(validation ? { validation: validation.outcome } : {}),
        ...(validation?.stat ?? {}),
      },
    });

    ctx.log.info(
      {
        validation: validation?.outcome ?? null,
        validationReport: report?.outcome ?? null,
        ...(validation?.stat ?? {}),
        hasSummary: summary !== null,
      },
      "the run was summarized",
    );

    // Nothing to ask the runner for: the queue carries on. See `PhaseDirective`.
    return undefined;
  };
}

/**
 * The closing line: the comparison, the size of the change, and the summary.
 *
 * One sentence per fact, in the order a reader wants them - what the run
 * achieved, how much it touched to achieve it, and whether the model explained
 * itself.
 */
function describeRun(
  validation: ValidationRecord | null,
  hasSummary: boolean,
  report: ValidationReport | null,
): string {
  const said = hasSummary
    ? "The session's own account of the change is recorded."
    : "The session ended without describing what it changed.";

  if (report) {
    return `${describeReport(report, validation)} ${said}`;
  }

  if (!validation) {
    // Not `unverified`, and the wording keeps them apart: that outcome means the
    // comparison ran and had nothing to compare against, where this means no
    // comparison happened - a pipeline built without an agent, so `testing` was
    // still a sleep. Reporting the second as the first would read as a fault in
    // a job that had none.
    return `Run finished with no validation recorded, so nothing is claimed about whether the change works. ${said}`;
  }

  return `Run finished ${validation.outcome}: ${OUTCOME_SENTENCES[validation.outcome]}${describeStat(validation)}. ${said}`;
}

function describeReport(report: ValidationReport, validation: ValidationRecord | null): string {
  const verdicts: string[] = [];
  const test = report.checks.find((check) => check.kind === "test");
  if (test) verdicts.push(describeTest(test));

  for (const kind of ["typecheck", "lint"] as const) {
    const check = report.checks.find((candidate) => candidate.kind === kind);
    if (check) verdicts.push(`${kind} ${check.outcome}`);
  }

  const outcome = `${report.outcome[0]?.toUpperCase() ?? ""}${report.outcome.slice(1)}`;
  const stat = validation ? describeStat(validation) : "";
  return verdicts.length > 0 ? `${outcome}: ${verdicts.join(", ")}${stat}.` : `${outcome}${stat}.`;
}

function describeTest(check: CheckComparison): string {
  if (!check.attribution) return `tests ${check.outcome}`;

  const attribution = check.attribution;
  const details = [
    attribution.preExistingFailures.length > 0
      ? `${countWithVerb(attribution.preExistingFailures.length, "was", "were")} already failing`
      : null,
    attribution.fixedFailures.length > 0
      ? `${countWithVerb(attribution.fixedFailures.length, "was", "were")} fixed`
      : null,
  ].filter((detail): detail is string => detail !== null);

  const newlyFailing = `${plural(attribution.newFailures.length, "test")} newly failing`;
  return details.length > 0 ? `${newlyFailing} (${details.join(", ")})` : newlyFailing;
}

function countWithVerb(count: number, singularVerb: string, pluralVerb: string): string {
  return `${count} ${count === 1 ? singularVerb : pluralVerb}`;
}

const OUTCOME_SENTENCES: Record<ValidationOutcome, string> = {
  verified: "the suite passed before the change and passes after it",
  fixed: "the suite was failing before the change and passes after it",
  regressed: "the change broke a suite that was green",
  unresolved: "the suite was failing before the change and is still failing",
  unverified: "there was nothing to compare against, so the change was not checked",
};

function describeStat(validation: ValidationRecord): string {
  const stat = validation.stat;
  if (!stat) return "";
  return ` (${plural(stat.filesChanged, "file")} changed, +${stat.insertions}/-${stat.deletions})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
