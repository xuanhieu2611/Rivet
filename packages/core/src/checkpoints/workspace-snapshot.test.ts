import type { ExecRequest, ExecResult, Sandbox } from "../sandbox/sandbox";
import { CheckpointTooLargeError } from "../jobs/failure";
import { describe, expect, it } from "vitest";

import {
  captureWorkspacePatch,
  parseCheckpointPatchStats,
  WorkspaceSnapshotError,
} from "./workspace-snapshot";

const REPOSITORY = "/home/node/workspace/repo";
const PATCH = Buffer.from(
  [
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n"),
);

function result(request: ExecRequest, overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    argv: request.argv,
    cwd: request.cwd,
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    oomKilled: false,
    durationMs: 1,
    ...overrides,
  };
}

function sandboxFor(respond: (request: ExecRequest) => ExecResult | Promise<ExecResult>): {
  sandbox: Sandbox;
  calls: ExecRequest[];
} {
  const calls: ExecRequest[] = [];
  const sandbox: Sandbox = {
    id: "sandbox-1",
    exec: async (request) => {
      calls.push(request);
      return respond(request);
    },
    getFile: () => Promise.reject(new Error("not used")),
    putFile: () => Promise.reject(new Error("not used")),
    putArchive: () => Promise.reject(new Error("not used")),
    destroy: () => Promise.resolve(),
  };
  return { sandbox, calls };
}

function captureInput(
  sandbox: Sandbox,
  overrides: Partial<Parameters<typeof captureWorkspacePatch>[0]> = {},
) {
  return {
    sandbox,
    repositoryDir: REPOSITORY,
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    maxBytes: 4_096,
    ...overrides,
  };
}

describe("parseCheckpointPatchStats", () => {
  it("counts text changes and ignores binary payload lines", () => {
    const patch = Buffer.from(
      [
        PATCH.toString("utf8").trimEnd(),
        "diff --git a/image.png b/image.png",
        "new file mode 100644",
        "index 0000000..1111111",
        "GIT binary patch",
        "literal 3",
        "abc+encoded-data",
        "",
      ].join("\n"),
    );

    expect(parseCheckpointPatchStats(patch)).toEqual({
      filesChanged: 2,
      insertions: 1,
      deletions: 1,
    });
  });
});

describe("captureWorkspacePatch", () => {
  it("uses an outside temporary index and returns a lossless patch with stats", async () => {
    const test = sandboxFor((request) => {
      if (request.argv[1] === "diff") return result(request, { stdout: PATCH.toString("utf8") });
      return result(request);
    });

    const snapshot = await captureWorkspacePatch(captureInput(test.sandbox));

    expect(snapshot.patch).toEqual(PATCH);
    expect(snapshot.stats).toEqual({ filesChanged: 1, insertions: 1, deletions: 1 });
    expect(test.calls.map((call) => call.argv.slice(0, 2))).toEqual([
      ["git", "read-tree"],
      ["git", "add"],
      ["git", "diff"],
      ["rm", "-f"],
    ]);

    const indexPaths = test.calls.slice(0, 3).map((call) => call.env?.GIT_INDEX_FILE);
    expect(indexPaths[0]).toMatch(/^\/tmp\/rivet-checkpoint-.+\.index$/);
    expect(indexPaths.every((path) => path === indexPaths[0])).toBe(true);
    expect(test.calls[0]?.cwd).toBe(REPOSITORY);
    expect(test.calls[3]?.cwd).toBe("/");
  });

  it("accepts an empty patch as a valid snapshot", async () => {
    const test = sandboxFor((request) => result(request));

    await expect(captureWorkspacePatch(captureInput(test.sandbox))).resolves.toMatchObject({
      patch: Buffer.alloc(0),
      stats: { filesChanged: 0, insertions: 0, deletions: 0 },
    });
  });

  it("rejects truncated output and still removes the temporary index", async () => {
    const test = sandboxFor((request) =>
      request.argv[1] === "diff"
        ? result(request, { stdout: "partial", truncated: true })
        : result(request),
    );

    await expect(captureWorkspacePatch(captureInput(test.sandbox))).rejects.toBeInstanceOf(
      WorkspaceSnapshotError,
    );
    expect(test.calls.at(-1)?.argv[0]).toBe("rm");
  });

  it("rejects an oversized complete patch instead of truncating it", async () => {
    const test = sandboxFor((request) =>
      request.argv[1] === "diff" ? result(request, { stdout: "x".repeat(20) }) : result(request),
    );

    await expect(
      captureWorkspacePatch(captureInput(test.sandbox, { maxBytes: 4 })),
    ).rejects.toBeInstanceOf(CheckpointTooLargeError);
    expect(test.calls.at(-1)?.argv[0]).toBe("rm");
  });

  it("keeps command evidence on a failed snapshot command", async () => {
    const test = sandboxFor((request) =>
      request.argv[1] === "add"
        ? result(request, { exitCode: 1, stderr: "index is locked\n" })
        : result(request),
    );

    await expect(captureWorkspacePatch(captureInput(test.sandbox))).rejects.toMatchObject({
      argv: ["git", "add", "-A"],
      stderr: "index is locked\n",
    });
  });
});
