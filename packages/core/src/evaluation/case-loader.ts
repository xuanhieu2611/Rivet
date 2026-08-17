import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  benchmarkCaseSchema,
  benchmarkIdSchema,
  type BenchmarkCase,
  type BenchmarkId,
} from "@rivet/contracts";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const GIT_OUTPUT_MAX_BYTES = 16 * 1_024 * 1_024;
const BENCHMARK_BRANCH = "main";
const BENCHMARK_COMMIT_MESSAGE = "Benchmark seed";
const SHA1_SCHEMA = z.string().regex(/^[a-f0-9]{40}$/i, "Expected a Git SHA-1.");
const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 hex digest.");

/** The small checked-in pin beside a benchmark case. */
export const benchmarkCaseLockSchema = z
  .object({
    versionHash: SHA256_SCHEMA,
    baseCommitSha: SHA1_SCHEMA,
  })
  .strict();

export type BenchmarkCaseLock = z.infer<typeof benchmarkCaseLockSchema>;

/** Options for loading a benchmark root. */
export interface LoadBenchmarkCasesOptions {
  /** Generated directories nested under the root, such as the builder output. */
  ignorePaths?: readonly string[];
}

/** A validated case and the derived identity of all of its source-controlled inputs. */
export interface LoadedBenchmarkCase {
  id: BenchmarkId;
  directory: string;
  repoDirectory: string;
  hiddenDirectory: string;
  spec: BenchmarkCase;
  versionHash: string;
  lock: BenchmarkCaseLock | null;
}

/** The result of turning one case into a local bare repository. */
export interface BuiltBenchmarkCase extends LoadedBenchmarkCase {
  bareRepository: string;
  baseCommitSha: string;
  treeSha: string;
  lock: BenchmarkCaseLock;
}

export type BenchmarkLockfileMode = "verify" | "write" | "ignore";

export interface BuildBenchmarkFixturesOptions {
  /** Directory containing one subdirectory per benchmark case. */
  benchmarkRoot: string;
  /** Directory in which `<case-id>.git` bare repositories are written. */
  outputRoot: string;
  /** Existing lockfiles are checked by default. */
  lockfileMode?: BenchmarkLockfileMode;
}

export interface BuildBenchmarkCaseOptions {
  benchmark: LoadedBenchmarkCase;
  outputRoot: string;
  lockfileMode?: BenchmarkLockfileMode;
}

/** A malformed case, unsafe fixture tree, or invalid lockfile. */
export class BenchmarkCaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BenchmarkCaseError";
  }
}

/** A deterministic fixture could not be built because Git failed. */
export class BenchmarkGitError extends BenchmarkCaseError {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stderr: string;

  constructor(
    message: string,
    details: { argv: readonly string[]; cwd: string; stderr?: string; cause?: unknown },
  ) {
    super(message, { cause: details.cause });
    this.name = "BenchmarkGitError";
    this.argv = details.argv;
    this.cwd = details.cwd;
    this.stderr = details.stderr ?? "";
  }
}

/** The checked-in pin disagrees with the fixture that was just rebuilt. */
export class BenchmarkLockfileMismatchError extends BenchmarkCaseError {
  readonly caseId: string;
  readonly expected: BenchmarkCaseLock;
  readonly actual: BenchmarkCaseLock;

  constructor(caseId: string, expected: BenchmarkCaseLock, actual: BenchmarkCaseLock) {
    const differences: string[] = [];
    if (expected.versionHash !== actual.versionHash) {
      differences.push(
        `versionHash ${expected.versionHash} (lock) != ${actual.versionHash} (built)`,
      );
    }
    if (expected.baseCommitSha !== actual.baseCommitSha) {
      differences.push(
        `baseCommitSha ${expected.baseCommitSha} (lock) != ${actual.baseCommitSha} (built)`,
      );
    }
    super(`Benchmark ${caseId} does not match its case.lock.json: ${differences.join("; ")}.`);
    this.name = "BenchmarkLockfileMismatchError";
    this.caseId = caseId;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Loads and validates every case directory below a benchmark root.
 *
 * Files such as a README are allowed at the root, but every directory is a
 * case and is therefore validated. This prevents a misspelled case from being
 * silently omitted from an evaluation matrix.
 */
export async function loadBenchmarkCases(
  benchmarkRoot: string,
  options: LoadBenchmarkCasesOptions = {},
): Promise<LoadedBenchmarkCase[]> {
  const root = await requireDirectory(benchmarkRoot, "benchmark root");
  const ignoredPaths = await Promise.all(
    (options.ignorePaths ?? []).map(async (path) => {
      try {
        return await realpath(path);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return resolve(path);
        throw error;
      }
    }),
  );
  const entries = await readdir(root, { withFileTypes: true });
  const caseDirectories: string[] = [];

  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (ignoredPaths.some((ignoredPath) => isPathInside(entryPath, ignoredPath))) continue;
    const entryInfo = await lstat(entryPath);
    if (entryInfo.isDirectory()) {
      caseDirectories.push(entryPath);
    } else if (entryInfo.isSymbolicLink()) {
      throw new BenchmarkCaseError(
        `Benchmark root ${root} contains a symlink where a case directory is expected: ${entry.name}.`,
      );
    }
  }

  caseDirectories.sort(comparePathNames);
  return Promise.all(caseDirectories.map((directory) => loadBenchmarkCase(directory)));
}

/** Loads and validates one case directory. */
export async function loadBenchmarkCase(caseDirectory: string): Promise<LoadedBenchmarkCase> {
  const directory = await requireDirectory(caseDirectory, "benchmark case");
  const id = parseBenchmarkId(basename(directory), directory);
  const casePath = join(directory, "case.json");
  const repoDirectory = join(directory, "repo");
  const hiddenDirectory = join(directory, "hidden");

  const spec = await readCaseSpec(casePath, id, directory);
  if (spec.id !== id) {
    throw new BenchmarkCaseError(
      `Benchmark ${directory} has id ${JSON.stringify(spec.id)} in case.json, ` +
        `but its directory is named ${JSON.stringify(id)}.`,
    );
  }

  await requireDirectory(repoDirectory, `repo directory for ${id}`);
  await requireDirectory(hiddenDirectory, `hidden directory for ${id}`);

  const repoEntries = await collectFixtureTree(repoDirectory, "repo", {
    rejectGitMetadata: true,
  });
  const hiddenEntries = await collectFixtureTree(hiddenDirectory, "hidden", {
    rejectGitMetadata: true,
  });
  if (hiddenEntries.length === 0) {
    throw new BenchmarkCaseError(`Benchmark ${id} must contain at least one hidden test file.`);
  }

  assertNoHiddenPathCollision(id, repoEntries, hiddenEntries);
  const versionHash = hashBenchmarkCase(spec, repoEntries, hiddenEntries);
  const lock = await readLockfile(join(directory, "case.lock.json"), id);

  return {
    id,
    directory,
    repoDirectory,
    hiddenDirectory,
    spec,
    versionHash,
    lock,
  };
}

/**
 * Builds all checked-in cases in stable order.
 *
 * The default lockfile mode is deliberately `verify`: a new case gets its
 * first lockfile, while an existing pin can never be silently rewritten.
 */
export async function buildBenchmarkFixtures(
  options: BuildBenchmarkFixturesOptions,
): Promise<BuiltBenchmarkCase[]> {
  const benchmarkRoot = resolve(options.benchmarkRoot);
  const outputRoot = resolve(options.outputRoot);
  const lockfileMode = options.lockfileMode ?? "verify";

  await mkdir(outputRoot, { recursive: true });
  const cases = await loadBenchmarkCases(benchmarkRoot, { ignorePaths: [outputRoot] });
  const built: BuiltBenchmarkCase[] = [];

  for (const benchmark of cases) {
    built.push(
      await buildBenchmarkCase({
        benchmark,
        outputRoot,
        lockfileMode,
      }),
    );
  }

  return built;
}

/** Builds one validated case into `<outputRoot>/<case-id>.git`. */
export async function buildBenchmarkCase(
  options: BuildBenchmarkCaseOptions,
): Promise<BuiltBenchmarkCase> {
  const benchmark = options.benchmark;
  const outputRoot = resolve(options.outputRoot);
  const lockfileMode = options.lockfileMode ?? "verify";
  const lock: BenchmarkCaseLock = {
    versionHash: benchmark.versionHash,
    baseCommitSha: "",
  };
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rivet-benchmark-build-"));
  const gitHome = join(temporaryRoot, "git-home");
  const worktree = join(temporaryRoot, "worktree");
  const stagingDirectory = await mkdtemp(join(outputRoot, `.${benchmark.id}.build-`));
  const stagedBareRepository = join(stagingDirectory, `${benchmark.id}.git`);
  const bareRepository = benchmarkBareRepositoryPath(outputRoot, benchmark.id);

  try {
    await mkdir(gitHome, { recursive: true });
    await runGit(["init", "--quiet", "--initial-branch", BENCHMARK_BRANCH, worktree], {
      cwd: temporaryRoot,
      gitHome,
    });
    await runGit(["config", "--local", "user.name", benchmark.spec.commit.author], {
      cwd: worktree,
      gitHome,
    });
    await runGit(["config", "--local", "user.email", benchmark.spec.commit.email], {
      cwd: worktree,
      gitHome,
    });
    await runGit(["config", "--local", "core.autocrlf", "false"], {
      cwd: worktree,
      gitHome,
    });
    await runGit(["config", "--local", "core.filemode", "true"], {
      cwd: worktree,
      gitHome,
    });

    await copyFixtureTree(benchmark.repoDirectory, worktree);
    await runGit(["add", "--force", "--all", "--", "."], {
      cwd: worktree,
      gitHome,
    });
    const commitEnvironment = {
      GIT_AUTHOR_NAME: benchmark.spec.commit.author,
      GIT_AUTHOR_EMAIL: benchmark.spec.commit.email,
      GIT_COMMITTER_NAME: benchmark.spec.commit.author,
      GIT_COMMITTER_EMAIL: benchmark.spec.commit.email,
      GIT_AUTHOR_DATE: normalizeGitDate(benchmark.spec.commit.date),
      GIT_COMMITTER_DATE: normalizeGitDate(benchmark.spec.commit.date),
    };
    await runGit(
      [
        "commit",
        "--quiet",
        "--allow-empty",
        "--no-verify",
        "--no-gpg-sign",
        "--message",
        BENCHMARK_COMMIT_MESSAGE,
      ],
      {
        cwd: worktree,
        gitHome,
        environment: commitEnvironment,
      },
    );

    const baseCommitSha = await gitValue(["rev-parse", "--verify", "HEAD"], worktree, gitHome);
    const treeSha = await gitValue(["rev-parse", "--verify", "HEAD^{tree}"], worktree, gitHome);
    lock.baseCommitSha = baseCommitSha;

    await runGit(["init", "--quiet", "--bare", stagedBareRepository], {
      cwd: temporaryRoot,
      gitHome,
    });
    await runGit(
      ["--git-dir", stagedBareRepository, "symbolic-ref", "HEAD", `refs/heads/${BENCHMARK_BRANCH}`],
      {
        cwd: temporaryRoot,
        gitHome,
      },
    );
    await runGit(
      [
        "-C",
        worktree,
        "push",
        "--quiet",
        "--no-thin",
        stagedBareRepository,
        `HEAD:refs/heads/${BENCHMARK_BRANCH}`,
      ],
      { cwd: temporaryRoot, gitHome },
    );

    assertLockfile(benchmark, lock, lockfileMode);
    await replaceBareRepository(stagedBareRepository, bareRepository);
    if (lockfileMode !== "ignore" && benchmark.lock === null) {
      await writeLockfile(join(benchmark.directory, "case.lock.json"), lock);
    } else if (lockfileMode === "write") {
      await writeLockfile(join(benchmark.directory, "case.lock.json"), lock);
    }

    return {
      ...benchmark,
      baseCommitSha,
      treeSha,
      bareRepository,
      lock,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

/** Returns the output path for a validated benchmark id without touching disk. */
export function benchmarkBareRepositoryPath(outputRoot: string, id: string): string {
  const parsedId = benchmarkIdSchema.safeParse(id);
  if (!parsedId.success) {
    throw new BenchmarkCaseError(`Invalid benchmark id ${JSON.stringify(id)}.`);
  }
  return join(resolve(outputRoot), `${parsedId.data}.git`);
}

interface FixtureEntry {
  relativePath: string;
  kind: "file" | "symlink";
  mode: number;
  content: Buffer;
}

interface CollectFixtureTreeOptions {
  rejectGitMetadata: boolean;
}

async function readCaseSpec(
  casePath: string,
  id: string,
  caseDirectory: string,
): Promise<BenchmarkCase> {
  let raw: string;
  try {
    raw = await readFile(casePath, "utf8");
  } catch (error) {
    throw new BenchmarkCaseError(`Could not read case.json for benchmark ${id} at ${casePath}.`, {
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new BenchmarkCaseError(`Benchmark ${id} has invalid JSON in ${casePath}.`, {
      cause: error,
    });
  }

  const parsed = benchmarkCaseSchema.safeParse(value);
  if (!parsed.success) {
    throw new BenchmarkCaseError(
      `Benchmark ${id} has an invalid case.json: ${formatZodIssues(parsed.error.issues)}.`,
    );
  }
  if (parsed.data.id !== basename(caseDirectory)) {
    throw new BenchmarkCaseError(
      `Benchmark ${caseDirectory} has a case.json id that does not match its directory.`,
    );
  }
  return parsed.data;
}

async function readLockfile(lockPath: string, id: string): Promise<BenchmarkCaseLock | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw new BenchmarkCaseError(`Could not read case.lock.json for benchmark ${id}.`, {
      cause: error,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new BenchmarkCaseError(`Benchmark ${id} has invalid JSON in ${lockPath}.`, {
      cause: error,
    });
  }

  const parsed = benchmarkCaseLockSchema.safeParse(value);
  if (!parsed.success) {
    throw new BenchmarkCaseError(
      `Benchmark ${id} has an invalid case.lock.json: ${formatZodIssues(parsed.error.issues)}.`,
    );
  }
  return parsed.data;
}

async function requireDirectory(path: string, description: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new BenchmarkCaseError(`The ${description} does not exist at ${path}.`, { cause: error });
  }
  if (!info.isDirectory()) {
    throw new BenchmarkCaseError(`The ${description} must be a directory: ${path}.`);
  }
  return realpath(path);
}

function parseBenchmarkId(value: string, directory: string): BenchmarkId {
  const parsed = benchmarkIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new BenchmarkCaseError(
      `Benchmark directory ${directory} has an invalid id ${JSON.stringify(value)}.`,
    );
  }
  return parsed.data;
}

async function collectFixtureTree(
  root: string,
  label: "repo" | "hidden",
  options: CollectFixtureTreeOptions,
): Promise<FixtureEntry[]> {
  const rootPath = await realpath(root);
  const entries: FixtureEntry[] = [];
  await walkFixtureTree(rootPath, rootPath, label, options, entries);
  entries.sort((left, right) => comparePathNames(left.relativePath, right.relativePath));
  return entries;
}

async function walkFixtureTree(
  root: string,
  directory: string,
  label: "repo" | "hidden",
  options: CollectFixtureTreeOptions,
  output: FixtureEntry[],
): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => comparePathNames(left.name, right.name));

  for (const child of children) {
    const childPath = join(directory, child.name);
    const relativePath = toPosixPath(relative(root, childPath));
    if (options.rejectGitMetadata && isGitMetadataPath(relativePath)) {
      throw new BenchmarkCaseError(
        `Benchmark ${label} contains reserved Git metadata at ${relativePath}.`,
      );
    }

    const info = await lstat(childPath);
    if (info.isDirectory()) {
      const before = output.length;
      await walkFixtureTree(root, childPath, label, options, output);
      if (output.length === before) {
        throw new BenchmarkCaseError(
          `Benchmark ${label} contains an empty directory at ${relativePath}.`,
        );
      }
      continue;
    }

    if (info.isSymbolicLink()) {
      await assertSafeSymlink(childPath, root, label, relativePath);
      output.push({
        relativePath,
        kind: "symlink",
        mode: 0o120000,
        content: Buffer.from(await readlink(childPath), "utf8"),
      });
      continue;
    }

    if (!info.isFile()) {
      throw new BenchmarkCaseError(
        `Benchmark ${label} contains an unsupported file type at ${relativePath}.`,
      );
    }

    output.push({
      relativePath,
      kind: "file",
      mode: info.mode & 0o111 ? 0o100755 : 0o100644,
      content: await readFile(childPath),
    });
  }
}

async function assertSafeSymlink(
  linkPath: string,
  root: string,
  label: "repo" | "hidden",
  relativePath: string,
): Promise<void> {
  const target = await readlink(linkPath);
  if (isAbsolute(target)) {
    throw new BenchmarkCaseError(
      `Benchmark ${label} contains an absolute symlink at ${relativePath}.`,
    );
  }

  const lexicalTarget = resolve(dirname(linkPath), target);
  if (!isPathInside(root, lexicalTarget)) {
    throw new BenchmarkCaseError(
      `Benchmark ${label} contains a symlink that escapes its root at ${relativePath}.`,
    );
  }

  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(lexicalTarget);
  } catch (error) {
    throw new BenchmarkCaseError(
      `Benchmark ${label} contains a dangling symlink at ${relativePath}.`,
      { cause: error },
    );
  }
  if (!isPathInside(root, resolvedTarget)) {
    throw new BenchmarkCaseError(
      `Benchmark ${label} contains a symlink that resolves outside its root at ${relativePath}.`,
    );
  }
}

function assertNoHiddenPathCollision(
  id: string,
  repoEntries: readonly FixtureEntry[],
  hiddenEntries: readonly FixtureEntry[],
): void {
  const repoPaths = repoEntries.map((entry) => entry.relativePath);
  for (const hiddenEntry of hiddenEntries) {
    const candidatePaths = [hiddenEntry.relativePath, `hidden/${hiddenEntry.relativePath}`];
    const collision = candidatePaths.find((candidatePath) =>
      repoPaths.some(
        (repoPath) =>
          repoPath === candidatePath ||
          repoPath.startsWith(`${candidatePath}/`) ||
          candidatePath.startsWith(`${repoPath}/`),
      ),
    );
    if (collision) {
      throw new BenchmarkCaseError(
        `Benchmark ${id} has a repo path that collides with hidden/${hiddenEntry.relativePath}.`,
      );
    }
  }
}

function hashBenchmarkCase(
  spec: BenchmarkCase,
  repoEntries: readonly FixtureEntry[],
  hiddenEntries: readonly FixtureEntry[],
): string {
  const hash = createHash("sha256");
  hash.update("rivet-benchmark-v1");
  updateHashPart(hash, canonicalJson(spec));
  for (const entry of repoEntries) {
    updateHashEntry(hash, "repo", entry);
  }
  for (const entry of hiddenEntries) {
    updateHashEntry(hash, "hidden", entry);
  }
  return hash.digest("hex");
}

function updateHashEntry(
  hash: ReturnType<typeof createHash>,
  tree: string,
  entry: FixtureEntry,
): void {
  updateHashPart(hash, tree);
  updateHashPart(hash, entry.relativePath);
  updateHashPart(hash, entry.kind);
  updateHashPart(hash, entry.mode.toString(8));
  updateHashPart(hash, entry.content);
}

function updateHashPart(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(Buffer.from(`${bytes.byteLength}:`, "ascii"));
  hash.update(bytes);
  hash.update(Buffer.from(";", "ascii"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new BenchmarkCaseError("Benchmark JSON contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([left], [right]) => comparePathNames(left, right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new BenchmarkCaseError("Benchmark JSON contains an unsupported value.");
}

async function copyFixtureTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  entries.sort((left, right) => comparePathNames(left.name, right.name));

  for (const entry of entries) {
    const sourcePath = join(sourceRoot, entry.name);
    const destinationPath = join(destinationRoot, entry.name);
    const info = await lstat(sourcePath);

    if (info.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyFixtureTree(sourcePath, destinationPath);
      continue;
    }
    if (info.isSymbolicLink()) {
      await symlink(await readlink(sourcePath), destinationPath);
      continue;
    }
    if (!info.isFile()) {
      throw new BenchmarkCaseError(`Cannot copy unsupported fixture entry ${sourcePath}.`);
    }

    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, info.mode & 0o777);
  }
}

function assertLockfile(
  benchmark: LoadedBenchmarkCase,
  actual: BenchmarkCaseLock,
  mode: BenchmarkLockfileMode,
): void {
  if (mode !== "verify" || benchmark.lock === null) return;
  if (
    benchmark.lock.versionHash !== actual.versionHash ||
    benchmark.lock.baseCommitSha !== actual.baseCommitSha
  ) {
    throw new BenchmarkLockfileMismatchError(benchmark.id, benchmark.lock, actual);
  }
}

async function writeLockfile(path: string, lock: BenchmarkCaseLock): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function replaceBareRepository(stagedPath: string, destinationPath: string): Promise<void> {
  await rm(destinationPath, { recursive: true, force: true });
  await rename(stagedPath, destinationPath);
}

async function gitValue(argv: readonly string[], cwd: string, gitHome: string): Promise<string> {
  const result = await runGit(argv, { cwd, gitHome });
  const value = result.stdout.trim();
  if (!value) {
    throw new BenchmarkGitError(`Git returned no value for ${argv.join(" ")}.`, {
      argv,
      cwd,
      stderr: result.stderr,
    });
  }
  return value;
}

interface RunGitOptions {
  cwd: string;
  gitHome: string;
  environment?: Record<string, string>;
}

async function runGit(
  argv: readonly string[],
  options: RunGitOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (argv.length === 0) throw new BenchmarkCaseError("A Git command needs an argv.");

  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "production",
    HOME: join(options.gitHome, "home"),
    XDG_CONFIG_HOME: join(options.gitHome, "config"),
    GIT_CONFIG_GLOBAL: join(options.gitHome, "global"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: join(options.gitHome, "system"),
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
    ...(options.environment ?? {}),
  };

  try {
    const result = await execFileAsync("git", [...argv], {
      cwd: options.cwd,
      env: environment,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_MAX_BYTES,
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (error) {
    const commandError = error as { stderr?: unknown; code?: unknown };
    const stderr = typeof commandError.stderr === "string" ? commandError.stderr : "";
    const code =
      typeof commandError.code === "string" || typeof commandError.code === "number"
        ? String(commandError.code)
        : undefined;
    const detail = stderr.trim() || (code ? `exit ${code}` : "spawn failure");
    throw new BenchmarkGitError(`Git command failed (${argv.join(" ")}): ${detail}.`, {
      argv,
      cwd: options.cwd,
      stderr,
      cause: error,
    });
  }
}

function normalizeGitDate(date: string): string {
  const trimmedDate = date.trim();
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(trimmedDate);
  const hasTime = /[T ]\d{2}:\d{2}/.test(trimmedDate);
  const parseableDate = hasExplicitTimezone || !hasTime ? trimmedDate : `${trimmedDate}Z`;
  const milliseconds = Date.parse(parseableDate);
  if (!Number.isFinite(milliseconds)) {
    throw new BenchmarkCaseError(`Invalid benchmark commit date ${JSON.stringify(date)}.`);
  }
  const wholeSeconds = Math.floor(milliseconds / 1_000) * 1_000;
  return new Date(wholeSeconds).toISOString();
}

function isGitMetadataPath(relativePath: string): boolean {
  return relativePath.split("/").includes(".git");
}

function isPathInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const pathDifference = relative(rootPath, candidatePath);
  return (
    pathDifference === "" ||
    (pathDifference !== ".." &&
      !pathDifference.startsWith(`..${sep}`) &&
      !isAbsolute(pathDifference))
  );
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function comparePathNames(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function formatZodIssues(issues: readonly z.ZodIssue[]): string {
  return issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
