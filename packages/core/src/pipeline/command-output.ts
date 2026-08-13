/**
 * Reading a command's transcript back, for the two things phases do with one.
 *
 * Both helpers are here rather than in a phase because the phases have to agree
 * about them: a failure message that says "exit 128" in one place and quotes the
 * tool's own last line in another makes two runs of the same problem look like
 * two different problems.
 */

/** Non-empty, trimmed lines. Directory listings and tool output both arrive this way. */
export function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The last thing the command said, which is where a tool puts its reason.
 *
 * stderr wins outright, and that is not arbitrary. A package manager announces
 * the command it is about to run on stdout and explains what went wrong on
 * stderr, so combining the two and taking the final line reports
 * `> node ./test.js` - the echo - as the reason a suite failed. Taking the last
 * stderr line reports `2 failed | 7 passed`. stdout is the fallback for the
 * tools that print their diagnosis there and write no stderr at all.
 *
 * What this produces ends up in `failure_reason` and in the timeline, so it is
 * the difference between a dashboard saying "fatal: repository not found" and
 * one saying "exit 128".
 */
export function problem(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): string {
  const last = splitLines(result.stderr).at(-1) ?? splitLines(result.stdout).at(-1);
  return last ? `exit ${result.exitCode ?? "(killed)"}: ${last}` : `exit ${result.exitCode}`;
}
