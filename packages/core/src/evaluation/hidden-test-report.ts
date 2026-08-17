/**
 * Turning a hidden-test run into a number, without pretending to know more
 * than the output says.
 *
 * The validation and baseline checks parse structured JSON reporter files
 * because they can: the repository under test is a Node project whose test
 * script Rivet resolved itself, and a reporter argument can be appended to it.
 * A benchmark case's `validationCommand` is not that. It is an argv the case
 * author wrote, run against a tree the model may have changed, and the only
 * thing the harness can rely on is its exit code.
 *
 * So this parser reads TAP - which is what `node --test` writes when its
 * output is not a terminal, and what every other runner in this family can be
 * asked for - and treats anything it cannot read as one assertion that either
 * passed or failed. That fallback is deliberately visible in `parsed`, because
 * a score of 1.0000 derived from an exit code and a score of 1.0000 derived
 * from 14 assertions are different amounts of evidence and the run row should
 * not flatten them.
 */

/** What the grading command reported about the hidden suite. */
export interface HiddenTestTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** False when the totals were derived from the exit code rather than read. */
  parsed: boolean;
}

/** The part of an `ExecResult` this parser needs. */
export interface HiddenTestCommandResult {
  exitCode: number | null;
  stdout: string;
  truncated?: boolean;
}

/**
 * TAP's plan summary, as `node --test` writes it:
 *
 * ```text
 * # tests 14
 * # pass 13
 * # fail 1
 * # skipped 0
 * ```
 *
 * The leading marker is required. Without it, a test whose own output happens
 * to contain the words would be read as the suite's totals, and a hidden test
 * that prints a diagnostic is a completely ordinary thing for a hidden test to
 * do. Node's non-TAP `spec` reporter uses `ℹ` for the same lines, so both
 * markers are accepted.
 */
const SUMMARY_LINE = /^(?:#|ℹ)\s+(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)$/u;

/**
 * Reads the totals a hidden-test command reported, or derives them.
 *
 * A truncated transcript is never parsed: the summary lines are at the end of
 * the output, so a clipped stdout can drop the totals and keep the `ok` lines,
 * which would report a suite as smaller than it was and inflate the score.
 */
export function parseHiddenTestReport(result: HiddenTestCommandResult): HiddenTestTotals {
  const succeeded = result.exitCode === 0;
  if (result.truncated === true) return derivedTotals(succeeded);

  const counts = new Map<string, number>();
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const match = SUMMARY_LINE.exec(rawLine.trim());
    if (!match) continue;
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue;
    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) continue;
    // Last writer wins: a run of several test files can print several summary
    // blocks, and the final one is the one that covers the whole invocation.
    counts.set(name, parsedValue);
  }

  const total = counts.get("tests");
  const passed = counts.get("pass");
  const failed = counts.get("fail");
  if (total === undefined || passed === undefined || failed === undefined) {
    return derivedTotals(succeeded);
  }
  if (passed + failed > total) return derivedTotals(succeeded);

  // A suite that reported no tests at all is not evidence of anything, and
  // scoring it 0/0 would put a NaN in a numeric column.
  if (total === 0) return derivedTotals(succeeded);

  const skipped = counts.get("skipped") ?? 0;
  return { total, passed, failed, skipped: Math.min(skipped, total), parsed: true };
}

/** Whether the hidden suite is to be treated as having passed. */
export function hiddenTestsPassed(
  result: HiddenTestCommandResult,
  totals: HiddenTestTotals,
): boolean {
  // The exit code leads, and the totals can only take the pass away. A runner
  // that exits zero having reported a failure is a runner nobody should trust,
  // and a benchmark is exactly where that has to be noticed.
  return result.exitCode === 0 && totals.failed === 0;
}

/**
 * The fraction of hidden assertions that passed, rounded to the stored scale.
 *
 * `numeric(5,4)` is what the column is, so the rounding happens here rather
 * than in Postgres: a score that changes when it is read back would make every
 * re-grade comparison in the acceptance contract meaningless.
 */
export function hiddenTestScore(totals: HiddenTestTotals): number {
  if (totals.total <= 0) return 0;
  const ratio = Math.min(Math.max(totals.passed / totals.total, 0), 1);
  return Math.round(ratio * 10_000) / 10_000;
}

function derivedTotals(succeeded: boolean): HiddenTestTotals {
  return {
    total: 1,
    passed: succeeded ? 1 : 0,
    failed: succeeded ? 0 : 1,
    skipped: 0,
    parsed: false,
  };
}
