import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import Docker from "dockerode";

/**
 * The shared Docker client, created on first use.
 *
 * The same rule as `@rivet/database` and `@rivet/queue`, for the same reason:
 * **importing this package must never connect to anything and must never
 * throw.** `pnpm build` and `pnpm test` both run in CI with no Docker daemon at
 * all, and that is the property CI's `verify` job exists to protect. Every
 * export here is a function, and the client is built inside it.
 *
 * Note that constructing a `Docker` does not open a socket either - dockerode
 * connects per request - so even a wrong path here costs nothing until someone
 * actually asks for a container.
 */

/**
 * Cached on `globalThis` outside production for the hot-reload reason.
 *
 * The web app never creates containers, so this is less load-bearing than the
 * Redis client's version of the same trick. It is here so that the three lazy
 * clients behave identically and nobody has to remember which one is the
 * exception.
 */
const globalForDocker = globalThis as unknown as { __rivetDocker?: Docker };

let client: Docker | undefined;

/** Docker Desktop on macOS. The user-scoped socket, which needs no root. */
const DESKTOP_SOCKET = join(homedir(), ".docker", "run", "docker.sock");

/** Linux, and the symlink Docker Desktop also installs. dockerode's own default. */
const SYSTEM_SOCKET = "/var/run/docker.sock";

/**
 * Where the daemon is, in the order the answers are trusted.
 *
 * `DOCKER_HOST` is read explicitly rather than left to dockerode's default
 * handling, because the fallback matters: on this machine Docker Desktop's real
 * socket is under `$HOME` and `/var/run/docker.sock` is a symlink to it that a
 * given install may or may not have created. Probing beats assuming, and the
 * result is logged by the caller, so a failure to connect says which path was
 * tried.
 */
export function dockerConnectionTarget(env: NodeJS.ProcessEnv = process.env): {
  socketPath: string;
  source: "DOCKER_HOST" | "desktop" | "system";
} {
  const host = env.DOCKER_HOST;
  if (host) {
    // Only the unix scheme is supported. A tcp:// daemon is a deliberate,
    // different decision - it is remote, usually unauthenticated, and the
    // sandbox suite refuses to create containers on one by accident.
    const socketPath = host.startsWith("unix://") ? host.slice("unix://".length) : host;
    return { socketPath, source: "DOCKER_HOST" };
  }
  if (existsSync(DESKTOP_SOCKET)) return { socketPath: DESKTOP_SOCKET, source: "desktop" };
  return { socketPath: SYSTEM_SOCKET, source: "system" };
}

export function getDocker(): Docker {
  client ??= globalForDocker.__rivetDocker;
  if (client) return client;

  client = new Docker({ socketPath: dockerConnectionTarget().socketPath });

  if (process.env.NODE_ENV !== "production") {
    globalForDocker.__rivetDocker = client;
  }
  return client;
}

/**
 * Forgets the shared client.
 *
 * There is no connection to close - dockerode holds no pool - so this exists
 * for tests that need the next `getDocker()` to re-read the environment.
 */
export function resetDocker(): void {
  client = undefined;
  delete globalForDocker.__rivetDocker;
}
