import { spawn, type ChildProcess } from "node:child_process";
import { createServer, Socket } from "node:net";

import { getDocker, SANDBOX_NETWORK } from "@rivet/sandbox";

/**
 * Serves bare repositories on a host path to containers, over `git://`.
 *
 * Extracted from `repo.ts` when the evaluation harness needed the same thing
 * for a different set of repositories. A bind-mounted `file://` repository
 * cannot satisfy `git clone --depth 1`, and a host path is not visible inside
 * the container anyway. The git protocol is still hermetic: the daemon serves
 * only the directory it is given and never touches the network outside the test
 * host.
 */
export interface GitDaemon {
  /** The clone URL for `<name>.git` below the served root. */
  url(name: string): string;
  close(): Promise<void>;
}

export async function serveBareRepositories(root: string): Promise<GitDaemon> {
  const port = await availablePort();
  const daemon = await spawnGitDaemon(root, port);
  const host = await containerHost();

  return {
    url: (name) => `git://${host}:${port}/${name}.git`,
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
    },
  };
}

async function spawnGitDaemon(root: string, port: number): Promise<ChildProcess> {
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
