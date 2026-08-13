import { describe, expect, it } from "vitest";

import { problem, splitLines } from "./command-output";

describe("problem", () => {
  it("quotes the last line of stderr, not the last line of everything", () => {
    // The case that made this a function rather than a template string: a
    // package manager echoes the command it is about to run on stdout and
    // explains the failure on stderr. Combining the two and taking the final
    // line reports the echo as the reason.
    expect(
      problem({
        exitCode: 1,
        stdout: "\n> widgets@1.0.0 test\n> node ./test.js\n",
        stderr: "2 failed | 7 passed\n",
      }),
    ).toBe("exit 1: 2 failed | 7 passed");
  });

  it("falls back to stdout for tools that write no stderr", () => {
    expect(problem({ exitCode: 2, stdout: "could not find a config file\n", stderr: "" })).toBe(
      "exit 2: could not find a config file",
    );
  });

  it("says the command was killed rather than printing a null exit code", () => {
    expect(problem({ exitCode: null, stdout: "", stderr: "signal received\n" })).toBe(
      "exit (killed): signal received",
    );
  });

  it("degrades to the exit code when the command said nothing at all", () => {
    expect(problem({ exitCode: 3, stdout: "  \n\n", stderr: "" })).toBe("exit 3");
  });
});

describe("splitLines", () => {
  it("drops blanks and trims what is left", () => {
    expect(splitLines("  a  \n\n b\n   \nc\n")).toEqual(["a", "b", "c"]);
    expect(splitLines("")).toEqual([]);
  });
});
