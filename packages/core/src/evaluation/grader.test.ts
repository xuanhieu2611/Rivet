import { describe, expect, it } from "vitest";

import type { JobCheckpoint } from "../checkpoints/checkpoint-store";
import { sha256CheckpointPatch } from "../checkpoints/checkpoint-store";
import type {
  ExecRequest,
  ExecResult,
  Sandbox,
  SandboxProvider,
  SandboxSpec,
} from "../sandbox/sandbox";
import { gradeEvaluationRun, type GradeEvaluationRunInput } from "./grader";
import type { JobOutcomeFacts } from "./run-classification";

const WORKDIR = "/home/node/workspace";
const REPO_DIR = `${WORKDIR}/repo`;
const BASE_COMMIT = "a".repeat(40);
const PATCH = Buffer.from(
  [
    "diff --git a/src/discount.js b/src/discount.js",
    "--- a/src/discount.js",
    "+++ b/src/discount.js",
    "-  return quantity > 10;",
    "+  return quantity >= 10;",
    "",
  ].join("\n"),
  "utf8",
);

const GREEN_TAP = ["TAP version 13", "# tests 8", "# pass 8", "# fail 0", "# skipped 0", ""].join(
  "\n",
);

const AMBER_TAP = ["TAP version 13", "# tests 8", "# pass 7", "# fail 1", "# skipped 0", ""].join(
  "\n",
);

interface HarnessOptions {
  job?: Partial<JobOutcomeFacts>;
  validationOutcome?: GradeEvaluationRunInput["validationOutcome"];
  checkpoint?: JobCheckpoint | null;
  checkpointError?: Error;
  /** What the re-derived capture produces. Defaults to the checkpoint's patch. */
  derivedPatch?: Buffer;
  seedCommitSha?: string;
  seedError?: Error;
  createError?: Error;
  putFileError?: Error;
  applyExitCode?: number;
  setupCommand?: readonly string[] | null;
  setupExitCode?: number;
  validation?: Partial<ExecResult>;
}

function checkpointFor(patch: Buffer): JobCheckpoint {
  return {
    id: 7,
    jobId: "job-1",
    sequence: 4,
    attemptCount: 1,
    kind: "phase_boundary",
    completedPhase: "reviewing",
    resumePhase: "finalizing",
    agentTurn: null,
    baseCommitSha: BASE_COMMIT,
    sandboxId: "container-1",
    envFingerprint: {},
    state: { version: 1 },
    patchFormat: "git_binary_full_index",
    patchCompression: "gzip",
    patchSha256: sha256CheckpointPatch(patch),
    patchByteSize: patch.byteLength,
    patchCompressedBytes: patch.byteLength,
    patch,
    restorePatch: patch,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function harness(options: HarnessOptions = {}) {
  const calls: ExecRequest[] = [];
  const writes: { path: string; content: string }[] = [];
  const archives: string[] = [];
  const specs: SandboxSpec[] = [];
  const destroyed: string[] = [];
  const checkpoint = options.checkpoint === undefined ? checkpointFor(PATCH) : options.checkpoint;
  const derived = options.derivedPatch ?? checkpoint?.patch ?? Buffer.alloc(0);
  let checkpointReads = 0;

  const sandbox: Sandbox = {
    id: "grading-container",
    exec: (request) => {
      calls.push(request);
      return Promise.resolve(respond(request));
    },
    getFile: () => Promise.reject(new Error("the grader reads no files")),
    putFile: (path, content) => {
      if (options.putFileError) return Promise.reject(options.putFileError);
      writes.push({ path, content });
      return Promise.resolve();
    },
    putArchive: (path) => {
      archives.push(path);
      return Promise.resolve();
    },
    destroy: () => {
      destroyed.push("grading-container");
      return Promise.resolve();
    },
  };

  function respond(request: ExecRequest): ExecResult {
    const argv = request.argv.join(" ");
    const base: ExecResult = {
      argv: request.argv,
      cwd: request.cwd,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      oomKilled: false,
      durationMs: 3,
    };

    if (argv.startsWith("git apply")) {
      const exitCode = options.applyExitCode ?? 0;
      return { ...base, exitCode, stderr: exitCode === 0 ? "" : "error: patch does not apply" };
    }
    if (argv === "git write-tree") return { ...base, stdout: `${"b".repeat(40)}\n` };
    if (argv.startsWith("git diff --cached")) {
      return { ...base, stdout: derived.toString("utf8") };
    }
    if (argv === options.setupCommand?.join(" ")) {
      return { ...base, exitCode: options.setupExitCode ?? 0 };
    }
    if (argv.startsWith("node --test")) {
      return { ...base, stdout: GREEN_TAP, ...options.validation };
    }
    return base;
  }

  const provider: SandboxProvider = {
    create: (spec) => {
      if (options.createError) return Promise.reject(options.createError);
      specs.push(spec);
      return Promise.resolve(sandbox);
    },
    reap: () => Promise.resolve([]),
  };

  const input: GradeEvaluationRunInput = {
    jobId: "job-1",
    job: {
      status: "completed",
      failureCategory: null,
      ...options.job,
    },
    validationOutcome: options.validationOutcome ?? "verified",
    benchmark: {
      id: "fixture-pass",
      repoUrl: "rivet-local:fixture-pass",
      baseBranch: "main",
      setupCommand: options.setupCommand ?? null,
      validationCommand: ["node", "--test", "hidden/"],
      hiddenFiles: [
        { path: "shipping.hidden.test.js", content: "// hidden\n", executable: false },
        { path: "support/run.sh", content: "#!/bin/sh\n", executable: true },
      ],
    },
    readCheckpoint: () => {
      checkpointReads += 1;
      if (options.checkpointError) return Promise.reject(options.checkpointError);
      return Promise.resolve(checkpoint);
    },
    seed: () => {
      if (options.seedError) return Promise.reject(options.seedError);
      return Promise.resolve({
        archive: new Uint8Array([1, 2, 3]),
        commitSha: options.seedCommitSha ?? BASE_COMMIT,
        treeSha: "c".repeat(40),
      });
    },
    seedTimeoutMs: 60_000,
    seedMaxBytes: 1_024 * 1_024,
    sandbox: {
      provider,
      image: "node@sha256:pinned",
      workdir: WORKDIR,
      memoryBytes: 2 * 1_024 * 1_024 * 1_024,
      nanoCpus: 2_000_000_000,
      pidsLimit: 512,
      commandTimeoutMs: 30_000,
      validationTimeoutMs: 120_000,
      maxOutputBytes: 64 * 1_024,
      maxPatchBytes: 4 * 1_024 * 1_024,
    },
    signal: new AbortController().signal,
    now: () => new Date("2026-02-02T00:00:00Z"),
  };

  return {
    input,
    calls,
    writes,
    archives,
    specs,
    destroyed,
    checkpointReads: () => checkpointReads,
    argvs: () => calls.map((call) => call.argv.join(" ")),
  };
}

describe("gradeEvaluationRun", () => {
  it("grades a completed job whose hidden tests pass", async () => {
    const world = harness();
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("passed");
    expect(graded.score).toBe(1);
    expect(graded.failureCategory).toBeNull();
    expect(graded.failureLabelSource).toBeNull();
    expect(graded.hiddenTests).toEqual({
      total: 8,
      passed: 8,
      failed: 0,
      skipped: 0,
      parsed: true,
    });
    expect(graded.sandboxId).toBe("grading-container");
    expect(world.destroyed).toEqual(["grading-container"]);
    expect(world.specs[0]?.image).toBe("node@sha256:pinned");
    // No credential, in a container that has nothing to withhold.
    expect(world.specs[0]?.env).toEqual({});
    expect(world.archives).toEqual([WORKDIR]);
  });

  it("fails a completed job whose hidden tests do not, with a partial score", async () => {
    // The run that justifies the whole hidden-test design: validation was
    // green, the reviewer may well have approved, and the change is wrong.
    const world = harness({ validation: { exitCode: 1, stdout: AMBER_TAP } });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("failed");
    expect(graded.score).toBe(0.875);
    expect(graded.hiddenTests?.failed).toBe(1);
  });

  it("labels an approved review of a failing change", async () => {
    const world = harness({
      job: { reviewDecision: "approve" },
      validation: { exitCode: 1, stdout: AMBER_TAP },
    });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("failed");
    expect(graded.failureCategory).toBe("Reviewer false positive");
    expect(graded.failureLabelSource).toBe("auto");
  });

  it("fails a green hidden suite whose job regressed its own validation", async () => {
    const world = harness({ validationOutcome: "regressed" });
    expect((await gradeEvaluationRun(world.input)).result).toBe("failed");
  });

  it("errors an infrastructure failure without reading or provisioning anything", async () => {
    const world = harness({
      job: { status: "failed", failureCategory: "sandbox_create_failed" },
    });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("errored");
    expect(graded.score).toBeNull();
    expect(graded.failureCategory).toBe("Environment failure");
    expect(graded.hiddenTests).toBeNull();
    expect(graded.sandboxId).toBeNull();
    expect(graded.gradedAt).toEqual(new Date("2026-02-02T00:00:00Z"));
    // The two assertions run E exists for: no container, and no work at all.
    expect(world.specs).toEqual([]);
    expect(world.checkpointReads()).toBe(0);
  });

  it("grades a task failure, because a tree that did nothing still has tests to fail", async () => {
    const world = harness({
      job: { status: "failed", failureCategory: "no_changes_produced" },
      validation: { exitCode: 1, stdout: AMBER_TAP },
    });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("failed");
    expect(world.specs).toHaveLength(1);
  });

  it("ungrades a workspace whose checksum disagrees", async () => {
    const world = harness({ derivedPatch: Buffer.from("diff --git a/x b/x\n+tampered\n", "utf8") });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("ungraded");
    expect(graded.score).toBeNull();
    expect(graded.failureCategory).toBe("grade_workspace_invalid");
    expect(graded.failureLabelSource).toBe("auto");
    expect(graded.detail).toContain("does not match checkpoint 4");
    expect(world.destroyed).toEqual(["grading-container"]);
  });

  it("ungrades a patch that will not apply", async () => {
    const world = harness({ applyExitCode: 1 });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("ungraded");
    expect(graded.detail).toContain("does not apply");
  });

  it("ungrades a seed that resolved to the wrong commit", async () => {
    // The check that catches a grader pointed at the wrong case: another
    // benchmark's patch will often apply cleanly, and the score would then be
    // the only symptom.
    const world = harness({ seedCommitSha: "d".repeat(40) });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("ungraded");
    expect(graded.detail).toContain("not the checkpoint's base commit");
    expect(world.specs).toEqual([]);
  });

  it("ungrades a job that reached a task outcome with no checkpoint", async () => {
    const world = harness({ checkpoint: null });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("ungraded");
    expect(graded.detail).toContain("without capturing a workspace");
  });

  it("ungrades a setup command that failed, rather than failing the run", async () => {
    const world = harness({ setupCommand: ["npm", "run", "build"], setupExitCode: 2 });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("ungraded");
    expect(graded.detail).toContain("setup command exited 2");
    // The transcript survives the verdict, so the broken fixture is diagnosable.
    expect(graded.commands.map((command) => command.phase)).toEqual(["setup"]);
  });

  it("runs setup before validation", async () => {
    const world = harness({ setupCommand: ["npm", "run", "build"] });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("passed");
    expect(graded.commands.map((command) => command.phase)).toEqual(["setup", "validation"]);
    const argvs = world.argvs();
    expect(argvs.indexOf("npm run build")).toBeLessThan(argvs.indexOf("node --test hidden/"));
  });

  it("clears the hidden directory before writing the case's own tests", async () => {
    const world = harness();
    await gradeEvaluationRun(world.input);

    const argvs = world.argvs();
    const cleared = argvs.indexOf(`rm -rf ${REPO_DIR}/hidden`);
    expect(cleared).toBeGreaterThan(-1);
    // After the checksum, so the tree that was compared is the job's own.
    const rederived = argvs.findIndex((argv) => argv.startsWith("git diff --cached"));
    expect(rederived).toBeGreaterThan(-1);
    expect(rederived).toBeLessThan(cleared);
    expect(world.writes.map((write) => write.path)).toEqual([
      `${WORKDIR}/rivet-grade.patch`,
      `${REPO_DIR}/hidden/shipping.hidden.test.js`,
      `${REPO_DIR}/hidden/support/run.sh`,
    ]);
    expect(argvs).toContain(`chmod 0755 ${REPO_DIR}/hidden/support/run.sh`);
  });

  it("destroys the grading container when a step throws", async () => {
    const world = harness({ putFileError: new Error("no space left on device") });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("ungraded");
    expect(world.destroyed).toEqual(["grading-container"]);
  });

  it("ungrades a container that could not be created", async () => {
    const world = harness({ createError: new Error("docker daemon is not running") });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("ungraded");
    expect(graded.sandboxId).toBeNull();
    expect(world.destroyed).toEqual([]);
  });

  it("ungrades a validation command that was killed", async () => {
    // A killed command is a statement about the grading sandbox, not about the
    // solution - the same distinction the baseline phase draws.
    const world = harness({ validation: { exitCode: null, stdout: "", timedOut: true } });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("ungraded");
    expect(graded.detail).toContain("killed before it completed");
  });

  it("propagates cancellation instead of calling it a grade", async () => {
    const controller = new AbortController();
    const world = harness({ seedError: new Error("aborted") });
    const input = { ...world.input, signal: controller.signal };
    controller.abort(new Error("the suite was cancelled"));

    await expect(gradeEvaluationRun(input)).rejects.toThrow("the suite was cancelled");
    expect(world.destroyed).toEqual([]);
  });

  it("grades an empty workspace without uploading a patch", async () => {
    const empty = Buffer.alloc(0);
    const world = harness({ checkpoint: checkpointFor(empty), derivedPatch: empty });
    const graded = await gradeEvaluationRun(world.input);

    expect(graded.result).toBe("passed");
    expect(world.writes.some((write) => write.path.endsWith("rivet-grade.patch"))).toBe(false);
    expect(world.argvs().some((argv) => argv.startsWith("git apply"))).toBe(false);
  });
});
