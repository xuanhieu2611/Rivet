import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { benchmarkRepositoryDirname, resolveBenchmarkRepositoryPath } from "./local-seed";

let root: string;
let fixtureRoot: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rivet-local-seed-"));
  fixtureRoot = join(root, "fixtures");
  outside = join(root, "outside.git");
  await mkdir(join(fixtureRoot, benchmarkRepositoryDirname("fixture-pass")), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(fixtureRoot, "not-a-directory.git"), "");
  // The one escape the scheme cannot prevent on its own: a case directory that
  // is a symlink out of the root.
  await symlink(outside, join(fixtureRoot, benchmarkRepositoryDirname("escaping-case")));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveBenchmarkRepositoryPath", () => {
  it("resolves a built case below the fixture root", async () => {
    await expect(
      resolveBenchmarkRepositoryPath({ repoUrl: "rivet-local:fixture-pass", fixtureRoot }),
    ).resolves.toBe(join(await realFixtureRoot(), "fixture-pass.git"));
  });

  it("refuses every URL that is not this scheme", async () => {
    for (const repoUrl of [
      "file:///tmp/x",
      "file:///etc/passwd",
      "https://github.com/rivet/rivet",
      "git://localhost/x.git",
    ]) {
      await expect(resolveBenchmarkRepositoryPath({ repoUrl, fixtureRoot })).rejects.toThrow(
        /not a valid rivet-local/u,
      );
    }
  });

  it("refuses every attempt to carry a path", async () => {
    for (const repoUrl of [
      "rivet-local:../../etc",
      "rivet-local:/etc/passwd",
      "rivet-local:a/../../b",
      "rivet-local://host/case",
      "rivet-local:",
    ]) {
      await expect(resolveBenchmarkRepositoryPath({ repoUrl, fixtureRoot })).rejects.toThrow(
        /not a valid rivet-local/u,
      );
    }
  });

  it("refuses a case directory symlinked out of the root", async () => {
    await expect(
      resolveBenchmarkRepositoryPath({ repoUrl: "rivet-local:escaping-case", fixtureRoot }),
    ).rejects.toThrow(/outside the fixture root/u);
  });

  it("refuses a case that has not been built", async () => {
    await expect(
      resolveBenchmarkRepositoryPath({ repoUrl: "rivet-local:never-built", fixtureRoot }),
    ).rejects.toThrow(/pnpm eval:build/u);
  });

  it("refuses a case whose entry is not a directory", async () => {
    await expect(
      resolveBenchmarkRepositoryPath({ repoUrl: "rivet-local:not-a-directory", fixtureRoot }),
    ).rejects.toThrow(/repository directory/u);
  });

  it("refuses a fixture root that does not exist", async () => {
    await expect(
      resolveBenchmarkRepositoryPath({
        repoUrl: "rivet-local:fixture-pass",
        fixtureRoot: join(root, "missing"),
      }),
    ).rejects.toThrow(/pnpm eval:build/u);
  });
});

/** macOS resolves the temp directory through a symlink, so compare realpaths. */
async function realFixtureRoot(): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(fixtureRoot);
}
