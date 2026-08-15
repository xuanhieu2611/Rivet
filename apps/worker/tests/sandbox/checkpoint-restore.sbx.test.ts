import { randomUUID } from "node:crypto";

import {
  captureWorkspacePatch,
  sha256CheckpointPatch,
  type Sandbox,
  type SandboxSpec,
} from "@rivet/core";
import { closeDb } from "@rivet/database";
import { DockerSandboxProvider } from "@rivet/sandbox";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_IMAGE } from "../../src/config";

/**
 * The half of recovery no unit test can prove: that the bytes survive.
 *
 * A checkpoint is only worth having if a patch captured in one container puts
 * the same working tree back in a different one, and the interesting cases are
 * exactly the ones a naive `git diff` loses - a new file, a deletion, an
 * executable bit, and a file that is not text at all. Two real containers, one
 * capture, one apply, and the same checksum on both sides.
 */

const controller = new AbortController();
const provider = new DockerSandboxProvider({
  workerId: `checkpoint-restore-${process.pid}`,
  reapGraceMs: 0,
});
const owned = new Set<Sandbox>();

const WORKDIR = process.env.SANDBOX_WORKDIR ?? "/home/node/workspace";
const REPO = `${WORKDIR}/repo`;
const PATCH_PATH = `${WORKDIR}/rivet-checkpoint.patch`;
const CAPTURE = { timeoutMs: 30_000, maxBytes: 4 * 1_024 * 1_024 };

function spec(): SandboxSpec {
  return {
    jobId: randomUUID(),
    image: process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
    workdir: WORKDIR,
    memoryBytes: 512 * 1_024 * 1_024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 128,
    env: {},
    labels: {},
  };
}

async function run(sandbox: Sandbox, argv: string[], cwd = REPO) {
  const result = await sandbox.exec({
    argv,
    cwd,
    timeoutMs: 30_000,
    signal: controller.signal,
    maxOutputBytes: 65_536,
  });
  expect(result.exitCode, `${argv.join(" ")}: ${result.stderr}`).toBe(0);
  return result;
}

/**
 * A repository whose base commit is identical in every container.
 *
 * The commit's own SHA differs between containers because its timestamp does,
 * and that is fine: `--full-index` records *blob* hashes, which are derived
 * from content alone. Identical base content is what makes the two patches
 * comparable, which is also why this fixture writes the same bytes both times.
 */
async function baseRepository(): Promise<Sandbox> {
  const sandbox = await provider.create(spec(), controller.signal);
  owned.add(sandbox);

  await sandbox.putFile(
    `${REPO}/src/sum.ts`,
    "export const sum = (a, b) => a + b;\n",
    controller.signal,
  );
  await sandbox.putFile(`${REPO}/src/legacy.ts`, "export const gone = true;\n", controller.signal);
  await sandbox.putFile(`${REPO}/script.sh`, "#!/bin/sh\necho hello\n", controller.signal);

  await run(sandbox, ["git", "init", "-q", "-b", "main"]);
  await run(sandbox, ["git", "add", "-A"]);
  await run(sandbox, [
    "git",
    "-c",
    "user.email=rivet@example.com",
    "-c",
    "user.name=Rivet",
    "commit",
    "-q",
    "-m",
    "base",
  ]);

  return sandbox;
}

afterEach(async () => {
  await Promise.all([...owned].map((sandbox) => sandbox.destroy()));
  owned.clear();
});

afterAll(async () => {
  await closeDb();
});

describe("checkpoint capture and restore across containers", () => {
  it("restores modifications, additions, deletions, modes and binary files byte for byte", async () => {
    const source = await baseRepository();

    // The four things a checkpoint has to survive, in one working tree.
    await source.putFile(
      `${REPO}/src/sum.ts`,
      "export const sum = (a, b) => a + b + 1;\n",
      controller.signal,
    );
    await source.putFile(`${REPO}/src/added.ts`, "export const added = true;\n", controller.signal);
    await run(source, ["rm", "src/legacy.ts"]);
    await run(source, ["chmod", "+x", "script.sh"]);
    await run(source, [
      "node",
      "-e",
      "require('fs').writeFileSync('logo.bin', Buffer.from([0,1,2,250,251,0,255]))",
    ]);

    const captured = await captureWorkspacePatch({
      sandbox: source,
      repositoryDir: REPO,
      signal: controller.signal,
      ...CAPTURE,
    });
    const checksum = sha256CheckpointPatch(captured.patch);
    expect(captured.stats.filesChanged).toBe(5);

    // A different container, the same base content, nothing else in common.
    const replacement = await baseRepository();
    expect(replacement.id).not.toBe(source.id);

    await replacement.putFile(
      PATCH_PATH,
      Buffer.from(captured.patch).toString("utf8"),
      controller.signal,
    );
    await run(replacement, ["git", "apply", "--binary", PATCH_PATH]);

    const restored = await captureWorkspacePatch({
      sandbox: replacement,
      repositoryDir: REPO,
      signal: controller.signal,
      ...CAPTURE,
    });

    // The claim `checkpoint.restored` makes, checked the way provisioning
    // checks it: re-derive the patch and compare the checksum.
    expect(sha256CheckpointPatch(restored.patch)).toBe(checksum);
    expect(restored.patch.byteLength).toBe(captured.patch.byteLength);

    // And the same claim from the filesystem's point of view, so a checksum
    // that agreed for the wrong reason would still be caught.
    const listing = await run(replacement, ["ls", "-l", "script.sh", "logo.bin", "src"]);
    expect(listing.stdout).toContain("added.ts");
    expect(listing.stdout).not.toContain("legacy.ts");
    expect(listing.stdout).toMatch(/-rwxr.xr.x[^\n]*script\.sh/);

    const binary = await run(replacement, [
      "node",
      "-e",
      "process.stdout.write(require('fs').readFileSync('logo.bin').toString('hex'))",
    ]);
    expect(binary.stdout).toBe("000102fafb00ff");
  });

  it("carries a rename as a delete and an add, and leaves the real index alone", async () => {
    const source = await baseRepository();
    await run(source, ["git", "mv", "src/sum.ts", "src/total.ts"]);
    await run(source, ["git", "reset", "-q"]);
    await source.putFile(`${REPO}/src/staged.ts`, "export const staged = 1;\n", controller.signal);
    await run(source, ["git", "add", "src/staged.ts"]);

    const captured = await captureWorkspacePatch({
      sandbox: source,
      repositoryDir: REPO,
      signal: controller.signal,
      ...CAPTURE,
    });
    const patch = Buffer.from(captured.patch).toString("utf8");

    // `--no-renames` on purpose: a rename recorded as a similarity score is a
    // patch whose meaning depends on the applying git's rename detection, and a
    // checkpoint format that can be re-interpreted is not a format.
    expect(patch).toContain("a/src/sum.ts");
    expect(patch).toContain("b/src/total.ts");
    expect(patch).not.toContain("rename from");

    // The capture ran through a temporary index, so the model's own staging
    // choices are exactly as they were: one staged file, and no more.
    const staged = await run(source, ["git", "diff", "--cached", "--name-only"]);
    expect(staged.stdout.trim()).toBe("src/staged.ts");

    const replacement = await baseRepository();
    await replacement.putFile(PATCH_PATH, patch, controller.signal);
    await run(replacement, ["git", "apply", "--binary", PATCH_PATH]);

    const restored = await captureWorkspacePatch({
      sandbox: replacement,
      repositoryDir: REPO,
      signal: controller.signal,
      ...CAPTURE,
    });
    expect(sha256CheckpointPatch(restored.patch)).toBe(sha256CheckpointPatch(captured.patch));

    const listing = await run(replacement, ["ls", "src"]);
    expect(listing.stdout).toContain("total.ts");
    expect(listing.stdout).not.toContain("sum.ts");
  });

  it("installs from the restored manifest and lockfile rather than the base commit's", async () => {
    const source = await baseRepository();
    await source.putFile(
      `${REPO}/package.json`,
      '{\n  "name": "fixture",\n  "version": "2.0.0",\n  "private": true\n}\n',
      controller.signal,
    );
    await source.putFile(
      `${REPO}/package-lock.json`,
      '{\n  "name": "fixture",\n  "version": "2.0.0",\n  "lockfileVersion": 3,\n' +
        '  "requires": true,\n  "packages": {\n    "": {\n      "name": "fixture",\n' +
        '      "version": "2.0.0"\n    }\n  }\n}\n',
      controller.signal,
    );

    const captured = await captureWorkspacePatch({
      sandbox: source,
      repositoryDir: REPO,
      signal: controller.signal,
      ...CAPTURE,
    });

    const replacement = await baseRepository();
    await replacement.putFile(
      PATCH_PATH,
      Buffer.from(captured.patch).toString("utf8"),
      controller.signal,
    );
    await run(replacement, ["git", "apply", "--binary", PATCH_PATH]);

    // The ordering provisioning depends on: an interrupted session may have
    // changed a manifest, and installing the base commit's first would
    // reconstruct a filesystem that session never had.
    await run(replacement, ["npm", "install", "--no-audit", "--no-fund"]);

    // `npm ls` exits non-zero when the installed tree and the lockfile disagree,
    // so a zero exit naming the restored version is npm's own statement that
    // the install it just did was the restored one.
    const installed = await run(replacement, ["npm", "ls"]);
    expect(installed.stdout).toContain("fixture@2.0.0");
  });

  it("refuses an oversized patch and still removes its temporary index", async () => {
    const source = await baseRepository();
    await source.putFile(`${REPO}/big.txt`, "x".repeat(8_192), controller.signal);

    const before = await run(source, ["sh", "-c", "ls /tmp | wc -l"]);
    await expect(
      captureWorkspacePatch({
        sandbox: source,
        repositoryDir: REPO,
        signal: controller.signal,
        timeoutMs: 30_000,
        maxBytes: 1_024,
      }),
    ).rejects.toThrow(/above the 1024-byte limit|truncated/);

    // Cleanup runs on every exit path, including the failing one: a rejected
    // capture that left its index behind would leak one file per turn into a
    // container that goes on running the job.
    const after = await run(source, ["sh", "-c", "ls /tmp | wc -l"]);
    expect(after.stdout.trim()).toBe(before.stdout.trim());

    // And the failure is the patch's size, not the workspace's state: the same
    // capture under the real bound still succeeds.
    const captured = await captureWorkspacePatch({
      sandbox: source,
      repositoryDir: REPO,
      signal: controller.signal,
      ...CAPTURE,
    });
    expect(captured.stats.filesChanged).toBe(1);
  });

  it("refuses a patch that does not apply to the base it was cut from", async () => {
    const source = await baseRepository();
    await source.putFile(
      `${REPO}/src/sum.ts`,
      "export const sum = (a, b) => a + b + 1;\n",
      controller.signal,
    );
    const captured = await captureWorkspacePatch({
      sandbox: source,
      repositoryDir: REPO,
      signal: controller.signal,
      ...CAPTURE,
    });

    const replacement = await baseRepository();
    // A base the patch was not cut from - the difference a checksum-verified
    // restore exists to notice, here caught one step earlier by git itself.
    await replacement.putFile(
      `${REPO}/src/sum.ts`,
      "export const sum = () => 0;\n",
      controller.signal,
    );
    await replacement.putFile(
      PATCH_PATH,
      Buffer.from(captured.patch).toString("utf8"),
      controller.signal,
    );

    const applied = await replacement.exec({
      argv: ["git", "apply", "--binary", PATCH_PATH],
      cwd: REPO,
      timeoutMs: 30_000,
      signal: controller.signal,
      maxOutputBytes: 65_536,
    });

    expect(applied.exitCode).not.toBe(0);
    expect(applied.stderr).toContain("patch does not apply");
  });
});
