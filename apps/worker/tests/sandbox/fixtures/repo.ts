import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { serveBareRepositories, type GitDaemon } from "./git-daemon";

const run = promisify(execFile);

export type FixtureVariant = "green" | "failing" | "no-tests" | "attribution" | "invalid-config";

export interface GitFixture {
  url(variant: FixtureVariant): string;
  commit(variant: FixtureVariant): string;
  close(): Promise<void>;
}

/**
 * Builds five tiny repositories and serves their bare clones with git-daemon.
 *
 * A bind-mounted `file://` repository cannot satisfy `git clone --depth 1`, and
 * a host path is not visible inside the container anyway. The git protocol is
 * still hermetic - the daemon serves only this temporary directory and never
 * touches the network outside the test host.
 */
export async function startGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "rivet-sandbox-fixture-"));
  const commits = new Map<FixtureVariant, string>();

  for (const variant of [
    "green",
    "failing",
    "no-tests",
    "attribution",
    "invalid-config",
  ] as const) {
    commits.set(variant, await buildRepository(root, variant));
  }

  const daemon: GitDaemon = await serveBareRepositories(root);

  return {
    url: (variant) => daemon.url(variant),
    commit: (variant) => {
      const commit = commits.get(variant);
      if (!commit) throw new Error(`No commit recorded for ${variant}.`);
      return commit;
    },
    close: async () => {
      await daemon.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function buildRepository(root: string, variant: FixtureVariant): Promise<string> {
  const worktree = join(root, `${variant}-worktree`);
  await mkdir(worktree);

  const name = `rivet-fixture-${variant}`;
  const scripts =
    variant === "no-tests"
      ? {}
      : {
          test: "node test.js",
          typecheck: "node typecheck.js",
          lint: "node lint.js",
        };
  const manifest = {
    name,
    version: "1.0.0",
    private: true,
    ...(variant === "attribution" ? { type: "module" } : {}),
    scripts,
  };
  const lockfile = {
    name,
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name, version: "1.0.0" } },
  };

  await writeFile(join(worktree, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(worktree, "package-lock.json"), `${JSON.stringify(lockfile, null, 2)}\n`);
  // An empty lockfile needs no registry. Pointing npm at a closed local port
  // turns that property into an assertion: a dependency or audit request makes
  // the hermetic suite fail instead of reaching the public npm registry.
  await writeFile(
    join(worktree, ".npmrc"),
    "registry=http://127.0.0.1:9/\naudit=false\nfund=false\n",
  );
  await writeFile(
    join(worktree, "test.js"),
    variant === "failing"
      ? 'console.error("fixture baseline failed"); process.exit(1);\n'
      : variant === "attribution"
        ? attributionTestRunner
        : 'console.log("fixture baseline passed");\n',
  );

  if (variant === "attribution") {
    await writeAttributionFixture(worktree);
  } else {
    await writeFile(join(worktree, "typecheck.js"), 'console.log("fixture typecheck passed");\n');
    await writeFile(join(worktree, "lint.js"), 'console.log("fixture lint passed");\n');
  }

  if (variant === "invalid-config") {
    await writeFile(
      join(worktree, "rivet.json"),
      `${JSON.stringify({ validation: { test: "node test.js" } }, null, 2)}\n`,
    );
  }

  await run("git", ["init", "-b", "main"], { cwd: worktree });
  await run("git", ["config", "user.name", "Rivet Sandbox Tests"], { cwd: worktree });
  await run("git", ["config", "user.email", "sandbox-tests@rivet.local"], { cwd: worktree });
  await run("git", ["add", "."], { cwd: worktree });
  await run("git", ["commit", "-m", `Create ${variant} fixture`], { cwd: worktree });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: worktree });
  await run("git", ["clone", "--bare", worktree, join(root, `${variant}.git`)]);
  return stdout.trim();
}

/**
 * M7 Stage 10 must exercise this fixture in both directions. After changing
 * `fixable` to true, the full suite remains red with only B failing and must
 * report `newFailures: []`, `preExistingFailures:
 * ["calculator.test.js::B"]`, and `fixedFailures:
 * ["calculator.test.js::A"]`. In a fresh run, changing `protectedBehavior` to
 * false must report `newFailures: ["calculator.test.js::C"]`. The former job
 * fails as unresolved; the latter is the regression case.
 */
async function writeAttributionFixture(worktree: string): Promise<void> {
  const config = {
    validation: {
      test: {
        argv: ["node", "test.js"],
        reporter: { framework: "vitest", outputArg: "--outputFile" },
      },
      typecheck: { argv: ["node", "typecheck.js"] },
      lint: { argv: ["node", "lint.js"] },
    },
  };

  await writeFile(join(worktree, "rivet.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(
    join(worktree, "calculator.js"),
    [
      "export const fixable = false;",
      "export const persistent = false;",
      "export const protectedBehavior = true;",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(worktree, "calculator.test.js"),
    [
      'import { fixable, persistent, protectedBehavior } from "./calculator.js";',
      "",
      "export const cases = [",
      '  { name: "A", passed: fixable },',
      '  { name: "B", passed: persistent },',
      '  { name: "C", passed: protectedBehavior },',
      "];",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(worktree, "typecheck.js"),
    'await import("./calculator.js"); console.log("fixture typecheck passed");\n',
  );
  await writeFile(
    join(worktree, "lint.js"),
    'await import("./calculator.test.js"); console.log("fixture lint passed");\n',
  );
}

const attributionTestRunner = `import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { cases } from "./calculator.test.js";

const assertions = cases.map(({ name, passed }) => ({
  ancestorTitles: [],
  fullName: name,
  status: passed ? "passed" : "failed",
  title: name,
}));
const failed = assertions.filter(({ status }) => status === "failed");
const passed = assertions.length - failed.length;
const report = {
  numFailedTestSuites: failed.length > 0 ? 1 : 0,
  numFailedTests: failed.length,
  numPassedTestSuites: failed.length === 0 ? 1 : 0,
  numPassedTests: passed,
  numPendingTestSuites: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numTotalTestSuites: 1,
  numTotalTests: assertions.length,
  startTime: Date.now(),
  success: failed.length === 0,
  testResults: [
    {
      assertionResults: assertions,
      endTime: Date.now(),
      message: "",
      name: resolve("calculator.test.js"),
      startTime: Date.now(),
      status: failed.length > 0 ? "failed" : "passed",
    },
  ],
};

const outputFlag = process.argv.findIndex(
  (argument) => argument === "--outputFile" || argument.startsWith("--outputFile="),
);
if (outputFlag >= 0) {
  const argument = process.argv[outputFlag] ?? "";
  const outputPath = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : process.argv[outputFlag + 1];
  if (!outputPath) throw new Error("--outputFile requires a path");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report) + "\\n");
}

for (const assertion of failed) console.error("FAIL " + assertion.fullName);
if (failed.length > 0) process.exitCode = 1;
`;
