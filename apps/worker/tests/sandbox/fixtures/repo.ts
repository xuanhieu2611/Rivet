import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { getDocker, SANDBOX_NETWORK } from "@rivet/sandbox";
import type { ChildProcess } from "node:child_process";

const run = promisify(execFile);

export type FixtureVariant = "green" | "failing" | "no-tests";

export interface GitFixture {
  url(variant: FixtureVariant): string;
  commit(variant: FixtureVariant): string;
  close(): Promise<void>;
}

/**
 * Builds three tiny repositories and serves their bare clones with git-daemon.
 *
 * A bind-mounted `file://` repository cannot satisfy `git clone --depth 1`, and
 * a host path is not visible inside the container anyway. The git protocol is
 * still hermetic - the daemon serves only this temporary directory and never
 * touches the network outside the test host.
 */
export async function startGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "rivet-sandbox-fixture-"));
  const commits = new Map<FixtureVariant, string>();

  for (const variant of ["green", "failing", "no-tests"] as const) {
    commits.set(variant, await buildRepository(root, variant));
  }

  const port = await availablePort();
  const daemon = await spawnGitDaemon(root, port);
  const host = await containerHost();

  return {
    url: (variant) => `git://${host}:${port}/${variant}.git`,
    commit: (variant) => {
      const commit = commits.get(variant);
      if (!commit) throw new Error(`No commit recorded for ${variant}.`);
      return commit;
    },
    close: async () => {
      daemon.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (daemon.exitCode !== null) return resolve();
        daemon.once("exit", () => resolve());
        setTimeout(() => {
          daemon.kill("SIGKILL");
          resolve();
        }, 2_000).unref();
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function buildRepository(root: string, variant: FixtureVariant): Promise<string> {
  const worktree = join(root, `${variant}-worktree`);
  await mkdir(worktree);

  const name = `rivet-fixture-${variant}`;
  const scripts = variant === "no-tests" ? {} : { test: "node test.js" };
  const manifest = { name, version: "1.0.0", private: true, scripts };
  const lockfile = {
    name,
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name, version: "1.0.0" } },
  };

  await writeFile(join(worktree, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(worktree, "package-lock.json"), `${JSON.stringify(lockfile, null, 2)}\n`);
  await writeFile(
    join(worktree, "test.js"),
    variant === "failing"
      ? 'console.error("fixture baseline failed"); process.exit(1);\n'
      : 'console.log("fixture baseline passed");\n',
  );

  await run("git", ["init", "-b", "main"], { cwd: worktree });
  await run("git", ["config", "user.name", "Rivet Sandbox Tests"], { cwd: worktree });
  await run("git", ["config", "user.email", "sandbox-tests@rivet.local"], { cwd: worktree });
  await run("git", ["add", "."], { cwd: worktree });
  await run("git", ["commit", "-m", `Create ${variant} fixture`], { cwd: worktree });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: worktree });
  await run("git", ["clone", "--bare", worktree, join(root, `${variant}.git`)]);
  return stdout.trim();
}

async function spawnGitDaemon(root: string, port: number): Promise<ChildProcess> {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    "git",
    [
      "daemon",
      "--reuseaddr",
      "--export-all",
      `--base-path=${root}`,
      "--listen=0.0.0.0",
      `--port=${port}`,
      root,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`git daemon exited early (${child.exitCode}): ${stderr}`);
    }
    if (await canConnect(port)) return child;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  child.kill("SIGKILL");
  throw new Error(`git daemon did not listen on port ${port}: ${stderr}`);
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a fixture port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(100);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
    socket.connect(port, "127.0.0.1");
  });
}

/** Docker Desktop provides a host alias; Linux containers use the bridge gateway. */
async function containerHost(): Promise<string> {
  if (process.platform === "darwin" || process.platform === "win32") {
    return "host.docker.internal";
  }

  const docker = getDocker();
  try {
    await docker.getNetwork(SANDBOX_NETWORK).inspect();
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    await docker.createNetwork({ Name: SANDBOX_NETWORK, Driver: "bridge" });
  }

  const network = await docker.getNetwork(SANDBOX_NETWORK).inspect();
  const gateway = network.IPAM?.Config?.find((entry) => entry.Gateway)?.Gateway;
  if (!gateway) throw new Error(`Docker network ${SANDBOX_NETWORK} has no gateway.`);
  return gateway;
}
