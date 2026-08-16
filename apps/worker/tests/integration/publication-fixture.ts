import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Repository } from "@rivet/contracts";
import type { FakeCodingAgent } from "@rivet/agent";
import { buildPipeline, type GitHubPipelineOptions, type PipelineOptions } from "@rivet/core";
import { FakeGitHubClient, type FakeGitHubOptions } from "@rivet/github";
import { FakeSandboxProvider, type ScriptedCommand } from "@rivet/sandbox";

import { publish, seedClone } from "../../src/git";
import {
  AGENT_OPTIONS,
  LISTING,
  MANIFEST,
  PIPELINE_OPTIONS,
  REPO_DIR,
  TRACKED,
} from "./review-fixture";

/**
 * The scaffolding Milestone 9's publication runs share.
 *
 * Two boundaries stay real here, and both are the point. The **remote is a
 * local bare repository**, so the claim this milestone rests on - that a patch
 * captured in a container applies on the host and produces the tree that was
 * validated - is asserted against real Git rather than against a fake written
 * to agree with it. And the **host Git operations are the production ones**:
 * `seedClone` and `publish` are imported from `src/git`.
 *
 * What is scripted is the sandbox, the model and the provider, exactly as
 * Milestone 8's fixture scripts the first two. The workspace a scripted
 * container reports is a real repository's capture, taken by the same commands
 * `captureWorkspacePatch` runs, which is what lets a fake sandbox hand the real
 * `publish` something it can actually apply.
 */

const run = promisify(execFile);

export const INSTALLATION_ID = 4_242;
export const REPO_OWNER = "rivet-test";
export const REPO_NAME = "publication-fixture";
export const ISSUE_NUMBER = 7;
export const ISSUE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${ISSUE_NUMBER}`;
export const APP_BASE_URL = "https://rivet.test";

/**
 * A distinctive credential, so "no token anywhere" is one grep rather than an
 * argument. Nothing these runs write should ever contain this string.
 */
export const SENTINEL_TOKEN = "ghs-rivet-sentinel-do-not-log-0987654321";

export const REPOSITORY: Repository = {
  id: 991,
  owner: REPO_OWNER,
  name: REPO_NAME,
  private: false,
  defaultBranch: "main",
};

/** One workspace state, as the capture commands actually report it. */
export interface CaptureVariant {
  /** `git diff --cached --binary ... HEAD`, byte for byte. */
  patch: string;
  /** `git write-tree` over the same temporary index. */
  treeSha: string;
  /** `git diff --cached --numstat`, which becomes the `diff_stat` artifact. */
  numstat: string;
  /** The file this variant edited, for readable assertions. */
  path: string;
  /** The commit the capture was taken against, which the sandbox reports too. */
  baseCommitSha: string;
}

export interface RemoteFixture {
  root: string;
  /** The bare repository standing in for GitHub. */
  remote: string;
  baseCommitSha: string;
  /** The workspace a first attempt validates. */
  first: CaptureVariant;
  /** A different validated workspace, for the resume whose tree changed. */
  second: CaptureVariant;
  destroy: () => Promise<void>;
}

/**
 * Builds the bare remote and the two capture variants taken against it.
 *
 * The variants are computed with the argv `captureWorkspacePatch` uses, against
 * a temporary index outside the repository. A patch produced any other way
 * would prove something about this file rather than about the capture the
 * pipeline performs.
 */
export async function createRemoteFixture(): Promise<RemoteFixture> {
  const root = await mkdtemp(join(tmpdir(), "rivet-publication-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");

  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "sum.ts"), "export const sum = 0;\n");
  await writeFile(join(source, "README.md"), "# Publication fixture\n");
  await writeFile(join(source, "package.json"), MANIFEST);
  await git(["init", "-b", "main", source]);
  await git(["-C", source, "config", "user.name", "Fixture Author"]);
  await git(["-C", source, "config", "user.email", "fixture@example.test"]);
  await git(["-C", source, "add", "-A"]);
  await git(["-C", source, "commit", "--message", "Base fixture"]);
  const baseCommitSha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
  await git(["clone", "--bare", source, remote]);

  return {
    root,
    remote,
    baseCommitSha,
    first: await captureVariant(root, remote, "first", "export const sum = 1;\n", baseCommitSha),
    second: await captureVariant(root, remote, "second", "export const sum = 2;\n", baseCommitSha),
    destroy: () => rm(root, { recursive: true, force: true }),
  };
}

async function captureVariant(
  root: string,
  remote: string,
  name: string,
  contents: string,
  baseCommitSha: string,
): Promise<CaptureVariant> {
  const work = join(root, `work-${name}`);
  await git(["clone", remote, work]);
  await writeFile(join(work, "src", "sum.ts"), contents);

  const index = join(root, `${name}.index`);
  const env = { GIT_INDEX_FILE: index };
  await git(["-C", work, "read-tree", "HEAD"], env);
  await git(["-C", work, "add", "-A"], env);
  const treeSha = (await git(["-C", work, "write-tree"], env)).trim();
  const patch = await git(
    [
      "-C",
      work,
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
    ],
    env,
  );
  const numstat = await git(["-C", work, "diff", "--cached", "--numstat", "HEAD"], env);

  return { patch, treeSha, numstat, path: "src/sum.ts", baseCommitSha };
}

async function git(argv: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run("git", argv, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 16 * 1_024 * 1_024,
  });
  return stdout;
}

/** A scripted answer that is computed when the command runs, not when it is written. */
function dynamic(match: (argv: string[]) => boolean, stdout: () => string): ScriptedCommand {
  return {
    match,
    get stdout() {
      return stdout();
    },
  };
}

const isCaptureDiff = (argv: string[]): boolean =>
  argv[0] === "git" && argv[1] === "diff" && argv.includes("--binary");

/**
 * A sandbox that reports a real repository's capture as its workspace.
 *
 * More than one variant makes the capture answers sequential, and that is what
 * a resume whose tree changed needs: the first capture of an attempt is the one
 * a restore re-derives and compares against its checkpoint, and every later
 * capture is the workspace the phase is about to publish. Expressing it any
 * other way would mean breaking the checksum that makes the restore
 * trustworthy in order to test the branch that comes after it.
 */
export function publicationSandbox(
  variants: CaptureVariant | readonly CaptureVariant[],
): FakeSandboxProvider {
  const ordered: CaptureVariant[] = Array.isArray(variants)
    ? [...(variants as readonly CaptureVariant[])]
    : [variants as CaptureVariant];
  // `git write-tree` runs immediately before the capture diff and once each, so
  // one counter keeps both answers describing the same workspace.
  let captures = 0;
  const current = (): CaptureVariant => ordered[Math.min(captures, ordered.length - 1)]!;
  const published = (): CaptureVariant =>
    ordered[Math.min(Math.max(captures - 1, 0), ordered.length - 1)]!;

  return new FakeSandboxProvider({
    script: [
      dynamic(
        (argv) => argv[0] === "git" && argv[1] === "write-tree",
        () => `${current().treeSha}\n`,
      ),
      dynamic(isCaptureDiff, () => {
        const variant = current();
        captures += 1;
        return variant.patch;
      }),
      dynamic(
        (argv) => argv[0] === "git" && argv[1] === "diff" && argv.includes("--numstat"),
        () => published().numstat,
      ),
      dynamic(
        (argv) => argv[0] === "git" && argv[1] === "diff",
        () => published().patch,
      ),
      dynamic(
        (argv) => argv[0] === "git" && argv[1] === "rev-parse",
        // The commit the container is really at: the seeded checkout, or the
        // scripted clone standing in for one.
        () => `${ordered[0]!.baseCommitSha}\n`,
      ),
      {
        match: (argv) => argv[0] === "git" && argv[1] === "ls-files",
        stdout: TRACKED,
      },
      { match: "ls", stdout: LISTING },
      { match: "cat", stdout: MANIFEST },
      { match: "sha256sum", stdout: "abc123  package-lock.json\n" },
      {
        match: (argv) => argv[0] === "npm" && argv[1] === "--version",
        stdout: "10.0.0\n",
      },
      {
        match: (argv) => argv[0] === "npm" && argv[1] === "run",
        stdout: "fixture tests passed\n",
      },
    ],
    files: { [`${REPO_DIR}/README.md`]: "The publication fixture.\n" },
  });
}

/** The production host Git operations, bounded for a local remote. */
export function publicationGitHub(client: FakeGitHubClient): GitHubPipelineOptions {
  return {
    client,
    seedClone,
    publish,
    seedMaxBytes: 64 * 1_024 * 1_024,
    // Real Git against a real repository, so the sandbox's millisecond budgets
    // do not apply: these bound processes, not scripted answers.
    cloneTimeoutMs: 30_000,
    pushTimeoutMs: 30_000,
  };
}

export function publicationClient(options: FakeGitHubOptions = {}): FakeGitHubClient {
  return new FakeGitHubClient({
    repositories: [REPOSITORY],
    tokenValue: SENTINEL_TOKEN,
    ...options,
  });
}

export interface PublicationPipelineInput {
  sandbox: FakeSandboxProvider;
  coding: FakeCodingAgent;
  /** Absent is `RIVET_GITHUB=off`, which is what run A's second half needs. */
  github?: GitHubPipelineOptions;
}

export function publicationPipeline(
  input: PublicationPipelineInput,
): ReturnType<typeof buildPipeline> {
  const options: PipelineOptions = {
    ...PIPELINE_OPTIONS,
    appBaseUrl: APP_BASE_URL,
    sandbox: input.sandbox,
    agent: { ...AGENT_OPTIONS, coding: input.coding },
    ...(input.github ? { github: input.github } : {}),
  };
  return buildPipeline(options);
}
