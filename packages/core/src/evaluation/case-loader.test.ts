import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  BenchmarkCaseError,
  BenchmarkLockfileMismatchError,
  buildBenchmarkFixtures,
  loadBenchmarkCases,
} from "./case-loader";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

const CASE = {
  id: "fixture-pass",
  title: "Fix the fixture boundary",
  category: "bug_fix" as const,
  difficulty: 1 as const,
  issue: "The boundary should include ten items.",
  setupCommand: null,
  validationCommand: ["node", "--test", "hidden/"],
  expectedBehavior: "Ten items qualify and the public tests remain green.",
  reviewMode: "independent" as const,
  maxCostUsd: "1.00",
  maxDurationSeconds: 900,
  commit: {
    author: "Rivet Benchmarks",
    email: "benchmarks@example.com",
    date: "2020-01-01T00:00:00.000",
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("benchmark fixture loader and builder", () => {
  it("builds the same commit and version hash twice", async () => {
    const firstRoot = await createBenchmarkRoot();
    const secondRoot = await createBenchmarkRoot();
    const firstOutput = join(firstRoot, ".rivet", "benchmarks");
    const secondOutput = join(secondRoot, ".rivet", "benchmarks");

    const first = (
      await buildBenchmarkFixtures({
        benchmarkRoot: firstRoot,
        outputRoot: firstOutput,
      })
    )[0]!;
    const second = (
      await buildBenchmarkFixtures({
        benchmarkRoot: secondRoot,
        outputRoot: secondOutput,
      })
    )[0]!;

    expect(second.versionHash).toBe(first.versionHash);
    expect(second.baseCommitSha).toBe(first.baseCommitSha);
    expect(second.treeSha).toBe(first.treeSha);

    const firstCommit = await git(
      [
        "--git-dir",
        first.bareRepository,
        "show",
        "-s",
        "--format=%an%n%ae%n%cn%n%ce%n%at%n%ct%n%s%n%P",
        "HEAD",
      ],
      firstRoot,
    );
    expect(firstCommit.stdout.trimEnd().split("\n")).toEqual([
      CASE.commit.author,
      CASE.commit.email,
      CASE.commit.author,
      CASE.commit.email,
      "1577836800",
      "1577836800",
      "Benchmark seed",
    ]);

    const lock = JSON.parse(
      await readFile(join(firstRoot, "fixture-pass", "case.lock.json"), "utf8"),
    ) as unknown;
    expect(lock).toEqual({
      versionHash: first.versionHash,
      baseCommitSha: first.baseCommitSha,
    });
  });

  it("includes hidden files in the version but not in the seed commit", async () => {
    const root = await createBenchmarkRoot();
    const output = join(root, ".rivet", "benchmarks");
    const original = (
      await buildBenchmarkFixtures({
        benchmarkRoot: root,
        outputRoot: output,
      })
    )[0]!;

    await writeFile(
      join(root, "fixture-pass", "hidden", "secret.test.js"),
      "// changed hidden fixture\n",
    );
    const changed = (
      await buildBenchmarkFixtures({
        benchmarkRoot: root,
        outputRoot: output,
        lockfileMode: "ignore",
      })
    )[0]!;

    expect(changed.versionHash).not.toBe(original.versionHash);
    expect(changed.baseCommitSha).toBe(original.baseCommitSha);
    const tree = await git(
      ["--git-dir", changed.bareRepository, "ls-tree", "-r", "--name-only", "HEAD"],
      root,
    );
    expect(tree.stdout).not.toContain("secret.test.js");
    expect(tree.stdout).toContain("src/value.txt");
  });

  it("changes the pinned commit when a seed file changes", async () => {
    const root = await createBenchmarkRoot();
    const output = join(root, ".rivet", "benchmarks");
    const original = (
      await buildBenchmarkFixtures({
        benchmarkRoot: root,
        outputRoot: output,
      })
    )[0]!;

    await writeFile(join(root, "fixture-pass", "repo", "src", "value.txt"), "changed\n");
    const changed = (
      await buildBenchmarkFixtures({
        benchmarkRoot: root,
        outputRoot: output,
        lockfileMode: "ignore",
      })
    )[0]!;

    expect(changed.versionHash).not.toBe(original.versionHash);
    expect(changed.baseCommitSha).not.toBe(original.baseCommitSha);
  });

  it("refuses to rebuild a case whose checked-in lock no longer matches", async () => {
    const root = await createBenchmarkRoot();
    const output = join(root, ".rivet", "benchmarks");
    await buildBenchmarkFixtures({ benchmarkRoot: root, outputRoot: output });
    await writeFile(join(root, "fixture-pass", "repo", "src", "value.txt"), "changed\n");

    await expect(
      buildBenchmarkFixtures({ benchmarkRoot: root, outputRoot: output }),
    ).rejects.toBeInstanceOf(BenchmarkLockfileMismatchError);
  });

  it("requires non-empty hidden tests and rejects repo collisions", async () => {
    const emptyRoot = await createBenchmarkRoot();
    await rm(join(emptyRoot, "fixture-pass", "hidden", "secret.test.js"));
    await expect(loadBenchmarkCases(emptyRoot)).rejects.toThrow(/at least one hidden test/);

    const collisionRoot = await createBenchmarkRoot();
    await mkdir(join(collisionRoot, "fixture-pass", "repo", "hidden"), { recursive: true });
    await writeFile(
      join(collisionRoot, "fixture-pass", "repo", "hidden", "secret.test.js"),
      "public\n",
    );
    await expect(loadBenchmarkCases(collisionRoot)).rejects.toThrow(/collides/);
  });

  it("rejects unknown case fields before building anything", async () => {
    const root = await createBenchmarkRoot();
    await writeFile(
      join(root, "fixture-pass", "case.json"),
      `${JSON.stringify({ ...CASE, unexpected: true }, null, 2)}\n`,
    );

    await expect(loadBenchmarkCases(root)).rejects.toBeInstanceOf(BenchmarkCaseError);
  });
});

async function createBenchmarkRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rivet-benchmark-loader-test-"));
  temporaryRoots.push(root);
  const caseRoot = join(root, CASE.id);
  await mkdir(join(caseRoot, "repo", "src"), { recursive: true });
  await mkdir(join(caseRoot, "hidden"), { recursive: true });
  await writeFile(join(caseRoot, "case.json"), `${JSON.stringify(CASE, null, 2)}\n`);
  await writeFile(join(caseRoot, "repo", "src", "value.txt"), "original\n");
  await writeFile(
    join(caseRoot, "hidden", "secret.test.js"),
    "// RIVET_HIDDEN_SENTINEL_fixture-pass\n",
  );
  return root;
}

async function git(
  argv: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", [...argv], {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1_024 * 1_024,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}
