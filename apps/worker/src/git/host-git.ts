import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PushRejectedError, RepoUnavailableError, type GitHubToken } from "@rivet/core";

/** The identity used for commits when the caller does not provide the App bot identity. */
export const DEFAULT_GITHUB_BOT_IDENTITY = {
  name: "Rivet[bot]",
  email: "rivet[bot]@users.noreply.github.com",
} as const;

/** The author and committer identity applied to a publication commit. */
export interface GitIdentity {
  name: string;
  email: string;
}

/** A command record that is safe to retain: it intentionally contains no environment. */
export interface HostGitCommand {
  argv: readonly string[];
  cwd: string;
}

/** Hooks used by tests and by callers that want command-level observability. */
export interface HostGitObserver {
  onCommand?: (command: HostGitCommand) => void;
  onAskPassCreated?: (path: string) => void;
  onTemporaryDirectoryCreated?: (path: string) => void;
}

/** The smallest credential shape needed by host Git. */
export type GitCredential = Pick<GitHubToken, "value">;

interface HostGitOperationInput {
  token: GitCredential;
  /** Per-command timeout. The caller may use the same value for the operation's commands. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Parent directory for the short-lived clone. Defaults to the system temp directory. */
  temporaryDirectory?: string;
  observer?: HostGitObserver;
  onCommand?: (command: HostGitCommand) => void;
}

/** Input for cloning a private repository into an archive safe to upload to a sandbox. */
export interface SeedCloneInput extends HostGitOperationInput {
  /** `repoUrl` is accepted as an alias because it is the job column's name. */
  remoteUrl?: string;
  repoUrl?: string;
  baseBranch?: string;
  /** The exact commit the sandbox must start from. */
  baseCommitSha?: string;
  /** Alias for callers that already call this value `commitSha`. */
  commitSha?: string;
  /** Complete archive bound. A truncated repository is never a valid seed. */
  maxArchiveBytes?: number;
  /** Alias retained for callers that use the shorter name. */
  archiveMaxBytes?: number;
  maxBytes?: number;
}

/** The host-produced repository archive and the commit it contains. */
export interface SeedCloneResult {
  archive: Buffer;
  commitSha: string;
  treeSha: string;
}

/** A patch and its commit metadata for publication. */
export interface PublishInput extends HostGitOperationInput {
  remoteUrl?: string;
  repoUrl?: string;
  baseBranch?: string;
  baseCommitSha?: string;
  commitSha?: string;
  branch: string;
  patch: Uint8Array;
  /** `message` is accepted as an alias for callers that use Git's vocabulary. */
  commitMessage?: string;
  message?: string;
  identity?: GitIdentity;
  botName?: string;
  botEmail?: string;
  /** The ref state observed during reconciliation. Null means the branch was absent. */
  expectedRemoteCommitSha?: string | null;
}

/** The change totals returned with a publication commit. */
export interface GitChangeStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** The commit and tree that were pushed to the publication branch. */
export interface PublishResult extends GitChangeStats {
  commitSha: string;
  treeSha: string;
  stats: GitChangeStats;
  /** True when the caller supplied an observed remote ref and replaced it. */
  forced: boolean;
}

/** A host Git command failed without exposing the installation token. */
export class HostGitCommandError extends Error {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly reason: "exit" | "spawn" | "timeout" | "aborted" | "output_limit";

  constructor(
    message: string,
    details: {
      argv: readonly string[];
      cwd: string;
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
      reason?: HostGitCommandError["reason"];
      cause?: unknown;
    },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "HostGitCommandError";
    this.argv = details.argv;
    this.cwd = details.cwd;
    this.exitCode = details.exitCode ?? null;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.reason = details.reason ?? "exit";
  }
}

/** A seed archive exceeded its complete-byte bound and was refused. */
export class SeedArchiveTooLargeError extends Error {
  readonly size: number;
  readonly maxBytes: number;

  constructor(size: number, maxBytes: number) {
    super(
      `The seeded repository archive is larger than its ${maxBytes}-byte limit ` +
        `(at least ${size} bytes were produced).`,
    );
    this.name = "SeedArchiveTooLargeError";
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_ARCHIVE_MAX_BYTES = 256 * 1_024 * 1_024;
const COMMAND_STDOUT_MAX_BYTES = 1 * 1_024 * 1_024;
const COMMAND_STDERR_MAX_BYTES = 64 * 1_024;
const ASKPASS_FILE_MODE = 0o700;
const PATCH_FILE_MODE = 0o600;

/**
 * Clones a repository with a read-scoped credential, checks out the requested
 * commit, removes its remote, and returns a complete tar archive.
 *
 * The credential is supplied to Git through a temporary askpass environment,
 * never through the remote URL or an argument. The clone directory, askpass
 * helper, temporary home and archive source are removed before this function
 * returns, including when Git or tar fails.
 */
export async function seedClone(input: SeedCloneInput): Promise<SeedCloneResult> {
  const remoteUrl = resolveRemoteUrl(input);
  const expectedCommit = resolveOptionalCommit(input.baseCommitSha, input.commitSha);
  const baseBranch = input.baseBranch ?? "main";
  const timeoutMs = resolveTimeout(input.timeoutMs);
  const maxArchiveBytes = resolveArchiveMaxBytes(input);
  const signal = input.signal ?? new AbortController().signal;
  const observer = resolveObserver(input);
  const token = validateToken(input.token);

  assertRemoteHasNoCredential(remoteUrl, token);
  assertNonEmpty("baseBranch", baseBranch);

  return withTemporaryDirectory(
    "rivet-github-seed-",
    input.temporaryDirectory,
    observer,
    async (root) => {
      let askPassPath: string | undefined;
      try {
        const credential = await createAskPass(root, token, observer);
        askPassPath = credential.path;
        const command = commandInput({
          cwd: root,
          env: credential.env,
          signal,
          timeoutMs,
          token,
          observer,
        });
        const repositoryDir = join(root, "repo");

        await runHostCommand(
          ["git", "clone", "--depth", "1", "--branch", baseBranch, remoteUrl, repositoryDir],
          command,
        );

        const commitSha = await checkoutExactCommit({
          repositoryDir,
          baseCommitSha: expectedCommit,
          baseBranch,
          command,
        });
        const treeSha = await revParse(repositoryDir, "HEAD^{tree}", command);

        // The archive is copied into an untrusted container. It must contain a
        // repository for the existing sandbox machinery, but no credential-bearing
        // remote that repository code could later inspect.
        await runHostCommand(["git", "remote", "remove", "origin"], {
          ...command,
          cwd: repositoryDir,
        });

        let archive: Buffer;
        try {
          const tar = await runHostCommand(["tar", "-C", root, "-cf", "-", "repo"], {
            ...command,
            cwd: root,
            maxStdoutBytes: maxArchiveBytes,
          });
          archive = tar.stdout;
        } catch (error) {
          if (error instanceof HostGitCommandError && error.reason === "output_limit") {
            throw new SeedArchiveTooLargeError(maxArchiveBytes + 1, maxArchiveBytes);
          }
          throw error;
        }

        if (archive.byteLength > maxArchiveBytes) {
          throw new SeedArchiveTooLargeError(archive.byteLength, maxArchiveBytes);
        }

        return { archive, commitSha, treeSha };
      } catch (error) {
        rethrowIfAborted(signal);
        if (error instanceof SeedArchiveTooLargeError) throw error;
        throw new RepoUnavailableError(
          `Could not seed the GitHub repository: ${describeHostGitError(error)}.`,
          { cause: error },
        );
      } finally {
        await removeQuietly(askPassPath);
      }
    },
  );
}

/**
 * Applies a validated workspace patch to a fresh host clone, commits it with
 * the App identity, and updates the publication ref using force-with-lease.
 *
 * The patch is applied to the immutable base commit, not to a remote branch's
 * current tree. This keeps a resumed publication from stacking an unreviewed
 * commit on top of an earlier attempt.
 */
export async function publish(input: PublishInput): Promise<PublishResult> {
  const remoteUrl = resolveRemoteUrl(input);
  const expectedBaseCommit = resolveOptionalCommit(input.baseCommitSha, input.commitSha);
  const baseBranch = input.baseBranch ?? "main";
  const timeoutMs = resolveTimeout(input.timeoutMs);
  const observer = resolveObserver(input);
  const token = validateToken(input.token);
  const signal = input.signal ?? new AbortController().signal;
  const identity = resolveIdentity(input);
  const commitMessage = input.commitMessage ?? input.message;
  const expectedRemoteCommitSha = input.expectedRemoteCommitSha;

  assertRemoteHasNoCredential(remoteUrl, token);
  assertNonEmpty("baseBranch", baseBranch);
  assertBranchName(input.branch);
  assertNonEmpty("commitMessage", commitMessage);
  assertNonEmpty("commit identity name", identity.name);
  assertNonEmpty("commit identity email", identity.email);
  if (expectedRemoteCommitSha !== undefined && expectedRemoteCommitSha !== null) {
    assertCommitSha(expectedRemoteCommitSha, "expectedRemoteCommitSha");
  }

  return withTemporaryDirectory(
    "rivet-github-publish-",
    input.temporaryDirectory,
    observer,
    async (root) => {
      let askPassPath: string | undefined;
      try {
        const credential = await createAskPass(root, token, observer);
        askPassPath = credential.path;
        const command = commandInput({
          cwd: root,
          env: credential.env,
          signal,
          timeoutMs,
          token,
          observer,
        });
        const repositoryDir = join(root, "repo");

        await runHostCommand(
          ["git", "clone", "--depth", "1", "--branch", baseBranch, remoteUrl, repositoryDir],
          command,
        );

        await checkoutExactCommit({
          repositoryDir,
          baseCommitSha: expectedBaseCommit,
          baseBranch,
          command,
        });
        await runHostCommand(["git", "checkout", "-B", input.branch, "HEAD"], {
          ...command,
          cwd: repositoryDir,
        });

        const patchPath = join(root, "rivet.patch");
        await writeFile(patchPath, Buffer.from(input.patch), { mode: PATCH_FILE_MODE });
        await chmod(patchPath, PATCH_FILE_MODE);

        await runHostCommand(["git", "apply", "--binary", patchPath], {
          ...command,
          cwd: repositoryDir,
        });
        await runHostCommand(["git", "add", "-A"], {
          ...command,
          cwd: repositoryDir,
        });

        const statsOutput = await runHostCommand(
          [
            "git",
            "diff",
            "--cached",
            "--numstat",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
          ],
          {
            ...command,
            cwd: repositoryDir,
          },
        );
        const stats = parseNumstat(statsOutput.stdout);

        const commitEnv = {
          ...command.env,
          GIT_AUTHOR_NAME: identity.name,
          GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name,
          GIT_COMMITTER_EMAIL: identity.email,
        };
        await runHostCommand(["git", "commit", "--no-verify", "--message", commitMessage], {
          ...command,
          cwd: repositoryDir,
          env: commitEnv,
        });

        const commitSha = await revParse(repositoryDir, "HEAD", command);
        const treeSha = await revParse(repositoryDir, "HEAD^{tree}", command);

        const lease =
          expectedRemoteCommitSha === undefined
            ? "--force-with-lease"
            : `--force-with-lease=refs/heads/${input.branch}:${expectedRemoteCommitSha ?? ""}`;
        try {
          await runHostCommand(
            ["git", "push", lease, "--porcelain", "origin", `HEAD:refs/heads/${input.branch}`],
            {
              ...command,
              cwd: repositoryDir,
            },
          );
        } catch (error) {
          rethrowIfAborted(signal);
          throw new PushRejectedError(
            `GitHub rejected the publication branch push: ${describeHostGitError(error)}.`,
            { cause: error },
          );
        }

        const forced = expectedRemoteCommitSha !== undefined && expectedRemoteCommitSha !== null;
        return { commitSha, treeSha, ...stats, stats, forced };
      } catch (error) {
        rethrowIfAborted(signal);
        throw error;
      } finally {
        await removeQuietly(askPassPath);
      }
    },
  );
}

interface CommandInput {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  token: string;
  observer: HostGitObserver;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

type RunHostCommandInput = CommandInput;

interface RunHostCommandResult {
  stdout: Buffer;
  stderr: Buffer;
}

interface AskPassCredential {
  path: string;
  env: Record<string, string>;
}

function commandInput(input: CommandInput): CommandInput {
  return {
    ...input,
    maxStdoutBytes: COMMAND_STDOUT_MAX_BYTES,
    maxStderrBytes: COMMAND_STDERR_MAX_BYTES,
  };
}

async function checkoutExactCommit(input: {
  repositoryDir: string;
  baseCommitSha: string | undefined;
  baseBranch: string;
  command: CommandInput;
}): Promise<string> {
  let current = await revParse(input.repositoryDir, "HEAD", input.command);
  if (input.baseCommitSha !== undefined && current !== input.baseCommitSha) {
    await runHostCommand(["git", "fetch", "--depth", "1", "origin", input.baseCommitSha], {
      ...input.command,
      cwd: input.repositoryDir,
    });
    await runHostCommand(["git", "checkout", "--detach", input.baseCommitSha], {
      ...input.command,
      cwd: input.repositoryDir,
    });
    current = await revParse(input.repositoryDir, "HEAD", input.command);
  }

  if (input.baseCommitSha !== undefined && current !== input.baseCommitSha) {
    throw new HostGitCommandError(
      `The ${input.baseBranch} clone resolved to ${current}, not the requested base commit.`,
      {
        argv: ["git", "checkout", "--detach", input.baseCommitSha],
        cwd: input.repositoryDir,
      },
    );
  }
  return current;
}

async function revParse(
  repositoryDir: string,
  expression: string,
  command: CommandInput,
): Promise<string> {
  const result = await runHostCommand(["git", "rev-parse", "--verify", expression], {
    ...command,
    cwd: repositoryDir,
  });
  const value = result.stdout.toString("utf8").trim();
  if (!value) {
    throw new HostGitCommandError(`Git returned no value for ${expression}.`, {
      argv: ["git", "rev-parse", "--verify", expression],
      cwd: repositoryDir,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    });
  }
  return value;
}

async function createAskPass(
  root: string,
  token: string,
  observer: HostGitObserver,
): Promise<AskPassCredential> {
  const askPassPath = join(root, "askpass.sh");
  const home = join(root, "home");
  const configHome = join(root, "config");
  await mkdir(home, { recursive: true });
  await mkdir(configHome, { recursive: true });
  await writeFile(
    askPassPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  *Username*|*username*) printf '%s\\n' \"$GIT_USERNAME\" ;;",
      "  *) printf '%s\\n' \"$RIVET_GIT_TOKEN\" ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: ASKPASS_FILE_MODE },
  );
  await chmod(askPassPath, ASKPASS_FILE_MODE);
  observer.onAskPassCreated?.(askPassPath);

  return {
    path: askPassPath,
    env: {
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: "0",
      GIT_USERNAME: "x-access-token",
      RIVET_GIT_TOKEN: token,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: home,
      XDG_CONFIG_HOME: configHome,
    },
  };
}

async function withTemporaryDirectory<T>(
  prefix: string,
  parent: string | undefined,
  observer: HostGitObserver,
  operation: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(parent ?? tmpdir(), prefix));
  try {
    observer.onTemporaryDirectoryCreated?.(root);
    return await operation(root);
  } finally {
    await removeQuietly(root);
  }
}

async function runHostCommand(
  argv: readonly string[],
  input: RunHostCommandInput,
): Promise<RunHostCommandResult> {
  if (argv.length === 0 || !argv[0]) throw new Error("A host command needs an executable.");
  assertNoSecret(argv, input.token);
  assertNoSecret([input.cwd], input.token);
  input.observer.onCommand?.({ argv: [...argv], cwd: input.cwd });

  if (input.signal.aborted) throw abortReason(input.signal);

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputLimit: "stdout" | "stderr" | undefined;
  let timedOut = false;
  let aborted = false;
  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let spawnError: Error | undefined;

  const child = spawn(argv[0], [...argv.slice(1)], {
    cwd: input.cwd,
    env: { ...process.env, ...input.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const terminate = (): void => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1_000);
    killTimer.unref();
  };

  const collect = (chunks: Buffer[], bytes: "stdout" | "stderr", chunk: Buffer): void => {
    const limit = bytes === "stdout" ? input.maxStdoutBytes : input.maxStderrBytes;
    const current = bytes === "stdout" ? stdoutBytes : stderrBytes;
    const next = current + chunk.byteLength;
    if (limit !== undefined && next > limit) {
      outputLimit ??= bytes;
      terminate();
      return;
    }
    chunks.push(chunk);
    if (bytes === "stdout") stdoutBytes = next;
    else stderrBytes = next;
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    collect(stdout, "stdout", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    collect(stderr, "stderr", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  const onAbort = (): void => {
    aborted = true;
    terminate();
  };
  input.signal.addEventListener("abort", onAbort, { once: true });

  if (input.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    timeoutTimer.unref();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", (error: Error) => {
      spawnError = error;
    });
    child.once("close", (code: number | null) => resolve(code));
  });

  input.signal.removeEventListener("abort", onAbort);
  if (killTimer) clearTimeout(killTimer);
  if (timeoutTimer) clearTimeout(timeoutTimer);

  const stdoutText = redactText(Buffer.concat(stdout).toString("utf8"), input.token);
  const stderrText = redactText(Buffer.concat(stderr).toString("utf8"), input.token);

  if (aborted) {
    throw abortReason(input.signal);
  }
  if (timedOut) {
    throw new HostGitCommandError(
      `Host command \`${argv.join(" ")}\` exceeded its ${input.timeoutMs}ms timeout.`,
      {
        argv,
        cwd: input.cwd,
        exitCode,
        stdout: stdoutText,
        stderr: stderrText,
        reason: "timeout",
      },
    );
  }
  if (outputLimit) {
    throw new HostGitCommandError(
      `Host command \`${argv.join(" ")}\` produced more ${outputLimit} than its configured limit.`,
      {
        argv,
        cwd: input.cwd,
        exitCode,
        stdout: stdoutText,
        stderr: stderrText,
        reason: "output_limit",
      },
    );
  }
  if (spawnError) {
    throw new HostGitCommandError(
      `Could not start host command \`${argv.join(" ")}\`: ${redactText(spawnError.message, input.token)}.`,
      {
        argv,
        cwd: input.cwd,
        exitCode,
        stdout: stdoutText,
        stderr: stderrText,
        reason: "spawn",
        cause: spawnError,
      },
    );
  }
  if (exitCode !== 0) {
    throw new HostGitCommandError(
      `Host command \`${argv.join(" ")}\` exited with code ${String(exitCode)}: ` +
        `${stderrText.trim() || stdoutText.trim() || "no output"}.`,
      {
        argv,
        cwd: input.cwd,
        exitCode,
        stdout: stdoutText,
        stderr: stderrText,
        reason: "exit",
      },
    );
  }

  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

function parseNumstat(output: Uint8Array): GitChangeStats {
  const stats: GitChangeStats = { filesChanged: 0, insertions: 0, deletions: 0 };
  const text = Buffer.from(output).toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    stats.filesChanged += 1;
    if (fields[0] !== "-") stats.insertions += parseLineCount(fields[0]);
    if (fields[1] !== "-") stats.deletions += parseLineCount(fields[1]);
  }
  return stats;
}

function parseLineCount(value: string | undefined): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function resolveRemoteUrl(input: { remoteUrl?: string; repoUrl?: string }): string {
  const remoteUrl = input.remoteUrl ?? input.repoUrl;
  if (remoteUrl === undefined || remoteUrl.trim().length === 0) {
    throw new Error("A host Git operation requires a repository URL.");
  }
  if (
    input.remoteUrl !== undefined &&
    input.repoUrl !== undefined &&
    input.remoteUrl !== input.repoUrl
  ) {
    throw new Error("remoteUrl and repoUrl must identify the same repository.");
  }
  return remoteUrl;
}

function resolveOptionalCommit(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  if (first !== undefined && second !== undefined && first !== second) {
    throw new Error("baseCommitSha and commitSha must identify the same commit.");
  }
  const value = first ?? second;
  if (value !== undefined) assertCommitSha(value, "baseCommitSha");
  return value;
}

function resolveArchiveMaxBytes(input: SeedCloneInput): number {
  const values = [input.maxArchiveBytes, input.archiveMaxBytes, input.maxBytes].filter(
    (value): value is number => value !== undefined,
  );
  if (values.length > 1 && values.some((value) => value !== values[0])) {
    throw new Error("maxArchiveBytes, archiveMaxBytes and maxBytes must agree.");
  }
  const value = values[0] ?? DEFAULT_ARCHIVE_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid maximum seed archive size: ${value}.`);
  }
  return value;
}

function resolveTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid host Git timeout: ${timeoutMs}.`);
  }
  return timeoutMs;
}

function resolveObserver(input: HostGitOperationInput): HostGitObserver {
  return {
    ...input.observer,
    ...(input.onCommand === undefined ? {} : { onCommand: input.onCommand }),
  };
}

function resolveIdentity(input: PublishInput): GitIdentity {
  if (input.identity !== undefined) return input.identity;
  return {
    name: input.botName ?? DEFAULT_GITHUB_BOT_IDENTITY.name,
    email: input.botEmail ?? DEFAULT_GITHUB_BOT_IDENTITY.email,
  };
}

function validateToken(token: GitCredential): string {
  if (!token || typeof token.value !== "string" || token.value.length === 0) {
    throw new Error("A host Git operation requires a non-empty installation token.");
  }
  return token.value;
}

function assertRemoteHasNoCredential(remoteUrl: string, token: string): void {
  if (remoteUrl.includes(token)) {
    throw new Error("The repository URL must not contain the installation token.");
  }
  if (/^(?:https?|ssh):\/\//i.test(remoteUrl)) {
    try {
      const parsed = new URL(remoteUrl);
      if (parsed.username || parsed.password) {
        throw new Error("The repository URL must not contain embedded credentials.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("embedded credentials")) throw error;
      throw new Error("The repository URL is not valid for a host Git operation.", {
        cause: error,
      });
    }
  }
}

function assertBranchName(branch: string): void {
  assertNonEmpty("branch", branch);
  const hasControlCharacter = [...branch].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20;
  });
  const hasForbiddenCharacter = [..."~^:?*[\\]"].some((character) => branch.includes(character));
  if (
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    hasControlCharacter ||
    hasForbiddenCharacter
  ) {
    throw new Error(`Invalid publication branch name: ${branch}.`);
  }
}

function assertCommitSha(value: string, field: string): void {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${field} must be a full Git commit id.`);
  }
}

function assertNonEmpty(field: string, value: string | undefined): asserts value is string {
  if (value === undefined || value.trim().length === 0) throw new Error(`${field} is required.`);
}

function assertNoSecret(values: readonly string[], secret: string): void {
  if (values.some((value) => value.includes(secret))) {
    throw new Error("The installation token may not be included in a host command.");
  }
}

function redactText(value: string, secret: string): string {
  return secret.length === 0 ? value : value.split(secret).join("[REDACTED]");
}

function describeHostGitError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rethrowIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Host Git operation aborted.");
}

async function removeQuietly(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}
