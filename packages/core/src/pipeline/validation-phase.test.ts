import type { JobDetail } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import type { BaselineOutcome } from "../events/baseline-log";
import {
  JobCancelledError,
  NoChangesProducedError,
  TerminalJobError,
  ValidationFailedError,
} from "../jobs/failure";
import { CommandTimedOutError, OutOfMemoryError } from "../sandbox/errors";
import type { ExecResult, Sandbox, SandboxProvider } from "../sandbox/sandbox";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import type {
  PhaseArtifactInput,
  PhaseContext,
  PhaseEventInput,
  PhaseExecInput,
  RecordedCommand,
} from "./phase-context";
import type { PipelineOptions } from "./phases";
import { parseNumstat, validationOutcome, validationPhase } from "./validation-phase";

/**
 * The milestone's centre of gravity, against a hand-made context: no database,
 * no Docker, no model.
 *
 * Three separable claims, and they are separated on purpose. The outcome matrix
 * is a pure function and is proved as a table. `--numstat` parsing is a pure
 * function and is proved against the shapes git actually emits. What is left for
 * the phase itself is the ordering that makes the other two trustworthy: the
 * diff is captured before anything can fail, an empty one is a result rather
 * than an absence, and a killed command is the sandbox's fault rather than the
 * repository's.
 */

const JOB = {
  id: "11111111-2222-3333-4444-555555555555",
  repoUrl: "https://github.com/acme/widgets",
  baseBranch: "main",
} as unknown as JobDetail;

const OPTIONS_BASE = {
  image: "node@sha256:deadbeef",
  workdir: "/home/node/workspace",
  memoryBytes: 2_147_483_648,
  nanoCpus: 2_000_000_000,
  pidsLimit: 512,
  commandTimeoutMs: 120_000,
  cloneTimeoutMs: 180_000,
  installTimeoutMs: 300_000,
  baselineTimeoutMs: 300_000,
  diffMaxBytes: 1_048_576,
};

const REPO_DIR = "/home/node/workspace/repo";

/** An npm project with a test script, unless a test says otherwise. */
const DEFAULT_LISTING = ".\n..\n.git\npackage.json\npackage-lock.json\nsrc\n";
const DEFAULT_MANIFEST = JSON.stringify({
  name: "widgets",
  scripts: { build: "tsc", test: "node --test" },
});

const DEFAULT_DIFF = [
  "diff --git a/src/discount.js b/src/discount.js",
  "index 1111111..2222222 100644",
  "--- a/src/discount.js",
  "+++ b/src/discount.js",
  "@@ -1,3 +1,3 @@",
  "-  return count > 10;",
  "+  return count >= 10;",
  "",
].join("\n");

const DEFAULT_NUMSTAT = "1\t1\tsrc/discount.js\n";

type Responder = (argv: string[]) => Partial<ExecResult> | undefined;

/** `baseline` defaults to `failed`, which is the fixture repository's own path. */
function harness(options: { respond?: Responder; baseline?: BaselineOutcome | null } = {}) {
  const holder = new SandboxHolder();
  const controller = new AbortController();
  const executed: PhaseExecInput[] = [];
  const events: PhaseEventInput[] = [];
  const artifacts: PhaseArtifactInput[] = [];

  const sandbox: Sandbox = {
    id: "c0ffee0c0ffee0c0ffee",
    exec: () => Promise.reject(new Error("the phase must go through ctx.exec")),
    getFile: () => Promise.reject(new Error("the validation phase reads no files")),
    putFile: () => Promise.reject(new Error("the validation phase writes no files")),
    destroy: () => Promise.resolve(),
  };
  holder.set(sandbox);

  const provider: SandboxProvider = {
    create: () => Promise.reject(new Error("the validation phase never creates a sandbox")),
    reap: () => Promise.resolve([]),
  };

  const pipelineOptions: PipelineOptions = { ...OPTIONS_BASE, sandbox: provider };

  const ctx: PhaseContext = {
    job: JOB,
    phase: { status: "testing", label: "Validate change", durationMs: 0 },
    sandboxes: holder,
    signal: controller.signal,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },

    exec: (input) => {
      executed.push(input);
      const scripted = options.respond?.(input.argv) ?? defaultResponse(input.argv);
      const result: RecordedCommand = {
        argv: input.argv,
        cwd: input.cwd,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        oomKilled: false,
        durationMs: 5,
        commandId: executed.length,
        commandExecutionId: `exec-${executed.length}`,
        ...scripted,
      };
      return Promise.resolve(result);
    },

    event: (input) => {
      events.push(input);
      return Promise.resolve();
    },

    artifact: (input) => {
      artifacts.push(input);
      return Promise.resolve(artifacts.length);
    },

    readBaseline: () =>
      Promise.resolve(options.baseline === undefined ? "failed" : options.baseline),

    // Both are `finalizing`'s to read. This phase writes the validation record
    // rather than reading one back.
    readSummary: () => Promise.reject(new Error("the summary is finalizing's to persist")),
    readValidation: () => Promise.reject(new Error("this phase writes the validation record")),

    recordProvisioning: () => Promise.resolve(),
    recordAgentUsage: () => Promise.resolve(),
    checkpoint: () => Promise.reject(new Error("the validation phase records no checkpoints")),
  };

  return {
    run: () => validationPhase(pipelineOptions)(ctx),
    controller,
    executed,
    events,
    artifacts,
    /** The one `validation.recorded` every completing path is supposed to write. */
    recorded: () => events.find((event) => event.type === "validation.recorded"),
    artifactOf: (type: string) => artifacts.find((artifact) => artifact.type === type),
  };
}

function defaultResponse(argv: string[]): Partial<ExecResult> | undefined {
  if (argv[0] === "ls") return { stdout: DEFAULT_LISTING };
  if (argv[0] === "cat") return { stdout: DEFAULT_MANIFEST };
  if (isGit(argv, "add")) return {};
  if (isGit(argv, "diff") && argv.includes("--numstat")) return { stdout: DEFAULT_NUMSTAT };
  if (isGit(argv, "diff")) return { stdout: DEFAULT_DIFF };
  return undefined;
}

function isGit(argv: string[], verb: string): boolean {
  return argv[0] === "git" && argv[1] === verb;
}

/** The suite's second run, which is the only thing most of these tests vary. */
function suiteExits(exitCode: number, stdout = ""): Responder {
  return (argv) => (argv.includes("run") ? { exitCode, stdout } : undefined);
}

describe("validationOutcome", () => {
  // The whole milestone as a table. Every row here is a sentence someone reads
  // off a dashboard, and the baseline column is what makes the "after" column
  // mean anything at all.
  it.each([
    ["passed", "passed", "verified"],
    ["passed", "failed", "regressed"],
    ["failed", "passed", "fixed"],
    ["failed", "failed", "unresolved"],
    ["skipped", "passed", "unverified"],
    ["skipped", "failed", "unverified"],
    ["skipped", "skipped", "unverified"],
  ] as const)("reads %s then %s as %s", (baseline, after, outcome) => {
    expect(validationOutcome(baseline, after)).toBe(outcome);
  });

  it("cannot claim anything when the suite could not be re-run", () => {
    // A repository with no `test` script is not a broken job. Failing it would
    // repeat exactly the mistake PRD §11 C exists to prevent.
    expect(validationOutcome("passed", "skipped")).toBe("unverified");
    expect(validationOutcome("failed", "skipped")).toBe("unverified");
  });

  it("treats a missing baseline as unverified rather than as skipped", () => {
    // Null means nobody looked - a resumed job, an older row, a database
    // hiccup - where `skipped` means `analyzing` looked and found nothing. Both
    // leave nothing to compare against, and attributing a failure nobody can
    // source to the session is the one thing this must not do.
    expect(validationOutcome(null, "passed")).toBe("unverified");
    expect(validationOutcome(null, "failed")).toBe("unverified");
  });
});

describe("parseNumstat", () => {
  it("sums the countable rows", () => {
    expect(parseNumstat("1\t2\tsrc/a.js\n10\t0\tsrc/b.js\n")).toEqual({
      filesChanged: 2,
      insertions: 11,
      deletions: 2,
    });
  });

  it("counts a binary file as a file and as no lines", () => {
    // `--numstat` reports `-` for a binary file rather than a number, so a diff
    // of one PNG is one file and zero lines. That is the honest reading of what
    // git actually said, and the reason the three numbers are not derivable
    // from each other.
    expect(parseNumstat("-\t-\tassets/logo.png\n")).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    });
  });

  it("counts a rename as the one file git says it is", () => {
    expect(parseNumstat("1\t1\tsrc/{old.js => new.js}\n")).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 1,
    });
  });

  it("counts a mode-only change, which has no lines at all", () => {
    expect(parseNumstat("0\t0\tscripts/run.sh\n")).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    });
  });

  it("is empty for an empty diff", () => {
    expect(parseNumstat("")).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
    expect(parseNumstat("\n\n")).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it("ignores anything that is not a numstat row", () => {
    // git prints warnings to stdout under some configurations, and one of them
    // counted as a changed file would quietly inflate every stat recorded here.
    const text = "warning: LF will be replaced by CRLF\n1\t0\tsrc/a.js\nnot a row at all\n";
    expect(parseNumstat(text)).toEqual({ filesChanged: 1, insertions: 1, deletions: 0 });
  });
});

describe("validationPhase", () => {
  it("stages the whole tree and diffs it against the clone's commit", async () => {
    const test = harness();

    await test.run();

    const argvs = test.executed.map((input) => input.argv.join(" "));
    expect(argvs).toContain("git add -A");
    expect(argvs).toContain("git diff --cached");
    expect(argvs).toContain("git diff --cached --numstat");
    // Every one of them inside the clone, never the sandbox's workdir.
    for (const input of test.executed) expect(input.cwd).toBe(REPO_DIR);
  });

  it("reads the diff with its own cap, above the artifact bound", async () => {
    const test = harness();

    await test.run();

    const diff = test.executed.find((input) => input.argv.join(" ") === "git diff --cached");
    expect(diff?.maxOutputBytes).toBe(OPTIONS_BASE.diffMaxBytes);
  });

  it("persists the diff and its stats as two artifacts", async () => {
    const test = harness();

    await test.run();

    expect(test.artifactOf("diff")?.content).toBe(DEFAULT_DIFF);
    expect(test.artifactOf("diff")?.metadata).toMatchObject({
      filesChanged: 1,
      insertions: 1,
      deletions: 1,
    });
    // The raw `--numstat`, because the per-file breakdown is the one thing the
    // totals on the event and the row's metadata cannot hold.
    expect(test.artifactOf("diff_stat")?.content).toBe(DEFAULT_NUMSTAT);
  });

  it("records the diff before it runs the suite", async () => {
    // The ordering is the deviation this milestone states up front: a job that
    // fails validation still produced work, and the evidence of what the model
    // did is the most valuable thing to keep from a run that went wrong.
    const test = harness({ respond: suiteExits(1) });

    await expect(test.run()).rejects.toBeInstanceOf(ValidationFailedError);
    expect(test.artifactOf("diff")).toBeDefined();
  });

  it("fails with no_changes_produced when the diff is empty", async () => {
    const test = harness({
      respond: (argv) => (isGit(argv, "diff") ? { stdout: "" } : undefined),
    });

    await expect(test.run()).rejects.toBeInstanceOf(NoChangesProducedError);
    // Nothing to keep and nothing to compare: the suite is never re-run.
    expect(test.artifacts).toEqual([]);
    expect(test.executed.some((input) => input.argv.includes("run"))).toBe(false);
  });

  it("treats a mode-only change as a change", async () => {
    // `0\t0\tpath` in the numstat and a header-only hunk in the diff. Either
    // witness is enough, and calling this "no changes" would be a lie about a
    // session that did something.
    const test = harness({
      respond: (argv) => {
        if (!isGit(argv, "diff")) return undefined;
        return argv.includes("--numstat")
          ? { stdout: "0\t0\tscripts/run.sh\n" }
          : { stdout: "diff --git a/scripts/run.sh b/scripts/run.sh\nold mode 100644\n" };
      },
    });

    await expect(test.run()).resolves.toBeUndefined();
    expect(test.recorded()?.data).toMatchObject({ filesChanged: 1 });
  });

  it("re-runs the script the baseline ran, on the baseline's budget", async () => {
    const test = harness();

    await test.run();

    const suite = test.executed.at(-1);
    expect(suite?.argv).toEqual(["npm", "run", "test"]);
    // The baseline's budget rather than the ordinary one, because it is the
    // same suite: a run that was allowed to be slow before must be allowed to
    // be slow now, or the comparison fails on the clock rather than the code.
    expect(suite?.timeoutMs).toBe(OPTIONS_BASE.baselineTimeoutMs);
  });

  it("passes a red baseline that is now green as fixed", async () => {
    const test = harness({ baseline: "failed" });

    await expect(test.run()).resolves.toBeUndefined();

    expect(test.recorded()?.data).toMatchObject({
      validation: "fixed",
      baseline: "failed",
      filesChanged: 1,
      insertions: 1,
      deletions: 1,
      exitCode: 0,
    });
  });

  it("passes a green baseline that is still green as verified", async () => {
    const test = harness({ baseline: "passed" });

    await expect(test.run()).resolves.toBeUndefined();
    expect(test.recorded()?.data).toMatchObject({ validation: "verified" });
  });

  it("fails a green baseline that went red as a regression", async () => {
    const test = harness({ baseline: "passed", respond: suiteExits(1, "2 failed | 7 passed\n") });

    await expect(test.run()).rejects.toBeInstanceOf(ValidationFailedError);

    expect(test.recorded()?.data).toMatchObject({ validation: "regressed" });
    // The event is written before the throw, so the timeline says what happened
    // rather than only that something did.
    expect(test.recorded()?.message).toContain("Regressed");
  });

  it("fails a red baseline that is still red as unresolved", async () => {
    const test = harness({ baseline: "failed", respond: suiteExits(1) });

    await expect(test.run()).rejects.toBeInstanceOf(ValidationFailedError);
    expect(test.recorded()?.data).toMatchObject({ validation: "unresolved" });
  });

  it("stays green and says nothing was checked when there is no test script", async () => {
    const test = harness({
      baseline: "skipped",
      respond: (argv) =>
        argv[0] === "cat"
          ? { stdout: JSON.stringify({ name: "widgets", scripts: { build: "tsc" } }) }
          : undefined,
    });

    await expect(test.run()).resolves.toBeUndefined();

    expect(test.recorded()?.data).toMatchObject({ validation: "unverified" });
    // A repository with no tests is not a broken job, and the diff is kept
    // exactly as it would be for a run that was checked.
    expect(test.artifactOf("diff")).toBeDefined();
  });

  it("fails the job when the working tree cannot be staged", async () => {
    // An unstaged tree produces an empty `git diff --cached`, so continuing
    // would report `no_changes_produced` for a session that may have changed a
    // great deal. A wrong answer about the work is worse than no answer.
    const test = harness({
      respond: (argv) =>
        isGit(argv, "add") ? { exitCode: 128, stderr: "not a git repository" } : undefined,
    });

    const error = await test.run().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TerminalJobError);
    expect(error).not.toBeInstanceOf(NoChangesProducedError);
    expect((error as Error).message).toContain("not a git repository");
  });

  it("fails the job when the suite outlives its timeout", async () => {
    // Not a fact about the change. `command_timed_out` says the sandbox stopped
    // a command; a regression says the change broke something.
    const test = harness({
      respond: (argv) => (argv.includes("run") ? { exitCode: null, timedOut: true } : undefined),
    });

    await expect(test.run()).rejects.toBeInstanceOf(CommandTimedOutError);
    expect(test.recorded()).toBeUndefined();
  });

  it("fails the job when the container runs out of memory", async () => {
    const test = harness({
      respond: (argv) =>
        argv.includes("run") ? { exitCode: null, timedOut: true, oomKilled: true } : undefined,
    });

    await expect(test.run()).rejects.toBeInstanceOf(OutOfMemoryError);
  });

  it("surfaces a cancellation as a cancellation, not as a regression", async () => {
    const test = harness({
      baseline: "passed",
      respond: (argv) => {
        if (!argv.includes("run")) return undefined;
        // What really happens on cancel: the container is killed mid-command,
        // so the suite comes back looking like it failed. The abort has to win,
        // or a cancelled job would leave a recorded regression that never
        // happened.
        test.controller.abort(new JobCancelledError("Cancelled by the user."));
        return { exitCode: null };
      },
    });

    await expect(test.run()).rejects.toBeInstanceOf(JobCancelledError);
    expect(test.recorded()).toBeUndefined();
    // And the diff still survives, which is the whole reason it is captured
    // first: a job cancelled between the session and its conclusion still
    // produced work.
    expect(test.artifactOf("diff")).toBeDefined();
  });

  it("says so when the sandbox clipped the diff on the way out", async () => {
    const test = harness({
      respond: (argv) =>
        isGit(argv, "diff") && !argv.includes("--numstat")
          ? { stdout: DEFAULT_DIFF, truncated: true }
          : undefined,
    });

    await test.run();

    expect(test.artifactOf("diff")?.metadata).toMatchObject({ sandboxClipped: true });
    expect(test.artifactOf("diff")?.message).toContain("understates");
  });
});
