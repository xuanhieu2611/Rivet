import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { RepoUnavailableError } from "@rivet/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  HostGitCommandError,
  localSeed,
  publish,
  reapHostGitTemporaryFiles,
  SeedArchiveTooLargeError,
  seedClone,
  type HostGitCommand,
} from "./host-git";

const runFile = promisify(execFile);
const TOKEN = "sentinel-installation-token-never-in-a-command";
const BOT_NAME = "Rivet Test[bot]";
const BOT_EMAIL = "rivet-test[bot]@users.noreply.github.com";
const temporaryRoots: string[] = [];

interface Fixture {
  root: string;
  source: string;
  remote: string;
  baseCommitSha: string;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("host Git operations", () => {
  it("seeds a clean repository archive without a remote or token-bearing command", async () => {
    const fixture = await createFixture();
    const commands: HostGitCommand[] = [];
    const askPassPaths: string[] = [];
    const temporaryDirectories: string[] = [];

    const result = await seedClone({
      repoUrl: fixture.remote,
      baseBranch: "main",
      baseCommitSha: fixture.baseCommitSha,
      token: { value: TOKEN },
      maxArchiveBytes: 8 * 1_024 * 1_024,
      observer: {
        onCommand: (command) => commands.push(command),
        onAskPassCreated: (path) => {
          askPassPaths.push(path);
          expect(statSync(path).mode & 0o777).toBe(0o700);
          expect(readFileSync(path, "utf8")).not.toContain(TOKEN);
        },
        onTemporaryDirectoryCreated: (path) => temporaryDirectories.push(path),
      },
    });

    expect(result.commitSha).toBe(fixture.baseCommitSha);
    expect(result.archive.byteLength).toBeGreaterThan(0);
    // Every entry belongs to the container's uid, whichever tar produced the
    // archive. Asserted from the bytes rather than from the argv because the
    // flag spelling differs between bsdtar and GNU tar and the property does
    // not: an argv assertion would have gone green on the spelling that only
    // one of the two accepts.
    expect(archiveOwners(result.archive)).toEqual([{ uid: 1000, gid: 1000 }]);
    expect(JSON.stringify(commands)).not.toContain(TOKEN);
    expect(askPassPaths).toHaveLength(1);
    expect(temporaryDirectories).toHaveLength(1);
    expect(statSync(temporaryDirectories[0]!, { throwIfNoEntry: false })).toBeUndefined();

    const archiveRoot = await mkdtemp(join(tmpdir(), "rivet-github-archive-test-"));
    temporaryRoots.push(archiveRoot);
    const archivePath = join(archiveRoot, "seed.tar");
    await writeFile(archivePath, result.archive);
    await runGit(["tar", "-xf", archivePath, "-C", archiveRoot]);

    await expect(
      runGit(["git", "rev-parse", "HEAD"], join(archiveRoot, "repo")),
    ).resolves.toMatchObject({
      stdout: `${fixture.baseCommitSha}\n`,
    });
    await expect(
      runGit(["git", "status", "--porcelain"], join(archiveRoot, "repo")),
    ).resolves.toMatchObject({
      stdout: "",
    });
    await expect(
      runGit(["git", "config", "--get", "remote.origin.url"], join(archiveRoot, "repo")),
    ).rejects.toBeDefined();
    await expect(readFile(join(archiveRoot, "repo", "binary.dat"))).resolves.toEqual(
      Buffer.from([0, 1, 2, 255, 3]),
    );
  });

  it("publishes the patch on a leased branch with an explicit bot identity", async () => {
    const fixture = await createFixture();
    const changedFile = join(fixture.source, "src", "value.txt");
    await writeFile(changedFile, "changed\n");
    const patch = Buffer.from(
      (await runGit(["git", "diff", "--binary", "HEAD"], fixture.source)).stdout,
    );
    const commands: HostGitCommand[] = [];
    const temporaryDirectories: string[] = [];
    const branch = "rivet/job-12345678-fix-value";

    const result = await publish({
      remoteUrl: fixture.remote,
      baseBranch: "main",
      baseCommitSha: fixture.baseCommitSha,
      branch,
      patch,
      commitMessage: "Fix the value",
      identity: { name: BOT_NAME, email: BOT_EMAIL },
      expectedRemoteCommitSha: null,
      token: { value: TOKEN },
      observer: {
        onCommand: (command) => commands.push(command),
        onTemporaryDirectoryCreated: (path) => temporaryDirectories.push(path),
      },
    });

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result).toMatchObject({ filesChanged: 1, insertions: 1, deletions: 1, forced: false });
    expect(result.stats).toEqual({ filesChanged: 1, insertions: 1, deletions: 1 });
    expect(JSON.stringify(commands)).not.toContain(TOKEN);
    expect(
      commands.some((command) =>
        command.argv.includes("--force-with-lease=refs/heads/rivet/job-12345678-fix-value:"),
      ),
    ).toBe(true);
    expect(temporaryDirectories).toHaveLength(1);
    expect(statSync(temporaryDirectories[0]!, { throwIfNoEntry: false })).toBeUndefined();

    const verificationRoot = await mkdtemp(join(tmpdir(), "rivet-github-publish-test-"));
    temporaryRoots.push(verificationRoot);
    const verification = join(verificationRoot, "repo");
    await runGit(["git", "clone", "--branch", branch, fixture.remote, verification]);
    await expect(runGit(["git", "rev-parse", "HEAD^"], verification)).resolves.toMatchObject({
      stdout: `${fixture.baseCommitSha}\n`,
    });
    await expect(
      runGit(["git", "show", "-s", "--format=%an%n%ae", "HEAD"], verification),
    ).resolves.toMatchObject({
      stdout: `${BOT_NAME}\n${BOT_EMAIL}\n`,
    });
    await expect(readFile(join(verification, "src", "value.txt"), "utf8")).resolves.toBe(
      "changed\n",
    );
  });

  it("seeds a local benchmark repository through the same archive path", async () => {
    const fixture = await createFixture();
    const commands: HostGitCommand[] = [];
    const askPassPaths: string[] = [];
    const temporaryDirectories: string[] = [];

    const result = await localSeed({
      repositoryPath: fixture.remote,
      baseBranch: "main",
      baseCommitSha: fixture.baseCommitSha,
      maxArchiveBytes: 8 * 1_024 * 1_024,
      observer: {
        onCommand: (command) => commands.push(command),
        onAskPassCreated: (path) => askPassPaths.push(path),
        onTemporaryDirectoryCreated: (path) => temporaryDirectories.push(path),
      },
    });

    expect(result.commitSha).toBe(fixture.baseCommitSha);
    expect(result.treeSha).toMatch(/^[0-9a-f]{40}$/u);
    // There is no credential in this operation, so there is no askpass helper
    // and nothing to redact - which is the point of a local fixture.
    expect(askPassPaths).toHaveLength(0);
    expect(temporaryDirectories).toHaveLength(1);
    expect(statSync(temporaryDirectories[0]!, { throwIfNoEntry: false })).toBeUndefined();

    // The archive is asserted with the same four properties the credentialed
    // seed is, because it is produced by the same helper and one forgotten tar
    // flag is what this run exists to catch.
    const archiveRoot = await mkdtemp(join(tmpdir(), "rivet-local-archive-test-"));
    temporaryRoots.push(archiveRoot);
    const archivePath = join(archiveRoot, "seed.tar");
    await writeFile(archivePath, result.archive);
    await runGit(["tar", "-xf", archivePath, "-C", archiveRoot]);
    const extracted = join(archiveRoot, "repo");

    await expect(runGit(["git", "rev-parse", "HEAD"], extracted)).resolves.toMatchObject({
      stdout: `${fixture.baseCommitSha}\n`,
    });
    await expect(runGit(["git", "status", "--porcelain"], extracted)).resolves.toMatchObject({
      stdout: "",
    });
    await expect(
      runGit(["git", "config", "--get", "remote.origin.url"], extracted),
    ).rejects.toBeDefined();
    await expect(readFile(join(extracted, "binary.dat"))).resolves.toEqual(
      Buffer.from([0, 1, 2, 255, 3]),
    );
    // The AppleDouble sidecars `COPYFILE_DISABLE=1` exists to prevent. On Linux
    // this is trivially true; on macOS it is the assertion that matters.
    const entries = await readdir(extracted, { recursive: true });
    expect(
      entries.filter((entry) => entry.split("/").some((part) => part.startsWith("._"))),
    ).toEqual([]);
    // A host path is never mentioned in the repository the container receives.
    await expect(readFile(join(extracted, ".git", "config"), "utf8")).resolves.not.toContain(
      fixture.remote,
    );
  });

  it("refuses a local repository that is not an absolute path", async () => {
    await expect(localSeed({ repositoryPath: "benchmarks/case.git" })).rejects.toThrow(
      /absolute path/u,
    );
  });

  it("reports a missing local repository as repo_unavailable and cleans up", async () => {
    const fixture = await createFixture();
    const temporaryDirectories: string[] = [];

    await expect(
      localSeed({
        repositoryPath: join(fixture.root, "does-not-exist.git"),
        observer: { onTemporaryDirectoryCreated: (path) => temporaryDirectories.push(path) },
      }),
    ).rejects.toBeInstanceOf(RepoUnavailableError);

    expect(temporaryDirectories).toHaveLength(1);
    expect(statSync(temporaryDirectories[0]!, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("refuses a local seed archive above its bound", async () => {
    const fixture = await createFixture();

    await expect(
      localSeed({ repositoryPath: fixture.remote, baseBranch: "main", maxArchiveBytes: 1_024 }),
    ).rejects.toBeInstanceOf(SeedArchiveTooLargeError);
  });

  it("reaps abandoned host Git state but spares a live operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rivet-host-git-reaper-test-"));
    temporaryRoots.push(root);
    const staleDirectory = join(root, "rivet-github-seed-abandoned");
    const liveDirectory = join(root, "rivet-local-seed-live");
    const staleIndex = join(root, "rivet-checkpoint-01234567-89ab-cdef-0123-456789abcdef.index");
    await mkdir(staleDirectory);
    await mkdir(liveDirectory);
    await writeFile(
      join(liveDirectory, ".rivet-host-operation"),
      JSON.stringify({ pid: process.pid }),
    );
    await writeFile(staleIndex, "stale");
    const old = new Date(Date.now() - 10_000);
    await Promise.all([
      utimes(staleDirectory, old, old),
      utimes(liveDirectory, old, old),
      utimes(staleIndex, old, old),
    ]);

    const removed = await reapHostGitTemporaryFiles({ directory: root, olderThanMs: 1_000 });

    expect(removed).toEqual(expect.arrayContaining([staleDirectory, staleIndex]));
    expect(removed).not.toContain(liveDirectory);
    await expect(readFile(join(liveDirectory, ".rivet-host-operation"))).resolves.toBeDefined();
  });

  it("removes the askpass helper and clone directory when a command fails", async () => {
    const fixture = await createFixture();
    const askPassPaths: string[] = [];
    const temporaryDirectories: string[] = [];

    await expect(
      seedClone({
        remoteUrl: join(fixture.root, "does-not-exist.git"),
        baseBranch: "main",
        token: { value: TOKEN },
        observer: {
          onAskPassCreated: (path) => askPassPaths.push(path),
          onTemporaryDirectoryCreated: (path) => temporaryDirectories.push(path),
        },
      }),
    ).rejects.toBeInstanceOf(RepoUnavailableError);

    expect(askPassPaths).toHaveLength(1);
    expect(temporaryDirectories).toHaveLength(1);
    expect(statSync(askPassPaths[0]!, { throwIfNoEntry: false })).toBeUndefined();
    expect(statSync(temporaryDirectories[0]!, { throwIfNoEntry: false })).toBeUndefined();

    const publishAskPassPaths: string[] = [];
    const publishTemporaryDirectories: string[] = [];
    await expect(
      publish({
        remoteUrl: fixture.remote,
        baseBranch: "main",
        baseCommitSha: fixture.baseCommitSha,
        branch: "rivet/job-invalid-patch",
        patch: Buffer.from("not a git patch\n"),
        commitMessage: "This will fail",
        token: { value: TOKEN },
        observer: {
          onAskPassCreated: (path) => publishAskPassPaths.push(path),
          onTemporaryDirectoryCreated: (path) => publishTemporaryDirectories.push(path),
        },
      }),
    ).rejects.toBeInstanceOf(HostGitCommandError);

    expect(statSync(publishAskPassPaths[0]!, { throwIfNoEntry: false })).toBeUndefined();
    expect(statSync(publishTemporaryDirectories[0]!, { throwIfNoEntry: false })).toBeUndefined();
  });
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rivet-host-git-fixture-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "value.txt"), "original\n");
  await writeFile(join(source, "binary.dat"), Buffer.from([0, 1, 2, 255, 3]));
  await runGit(["git", "init", "-b", "main", source]);
  await runGit(["git", "-C", source, "config", "user.name", "Fixture Author"]);
  await runGit(["git", "-C", source, "config", "user.email", "fixture@example.test"]);
  await runGit(["git", "-C", source, "add", "-A"]);
  await runGit(["git", "-C", source, "commit", "--message", "Base fixture"]);
  const baseCommitSha = (await runGit(["git", "-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await runGit(["git", "clone", "--bare", source, remote]);
  return { root, source, remote, baseCommitSha };
}

async function runGit(argv: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const [command, ...args] = argv;
  if (!command) throw new Error("Missing command");
  return runFile(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1_024 * 1_024,
  });
}

/**
 * The distinct (uid, gid) pairs in a tar archive, read straight from the ustar
 * headers. Enough of a parser to assert ownership without a dependency.
 *
 * The field widths are not interchangeable: uid and gid are 8 bytes at 108 and
 * 116, size is **12** at 124. Reading size as 8 truncates `000000005670` to
 * `00000005` and the walk lands inside file data, which is a failure that hides
 * on a fixture of small files and appears on a large one.
 */
function archiveOwners(archive: Buffer): { uid: number; gid: number }[] {
  const seen = new Map<string, { uid: number; gid: number }>();

  const octal = (offset: number, length: number): number =>
    Number.parseInt(
      archive
        .subarray(offset, offset + length)
        .toString("ascii")
        .replace(/\0.*$/, "")
        .trim() || "0",
      8,
    );

  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    // A header whose name starts with NUL is the end-of-archive marker.
    if (archive[offset] === 0) break;

    seen.set(`${octal(offset + 108, 8)}:${octal(offset + 116, 8)}`, {
      uid: octal(offset + 108, 8),
      gid: octal(offset + 116, 8),
    });

    const size = octal(offset + 124, 12);
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return [...seen.values()];
}
