import { dockerConnectionTarget } from "@rivet/sandbox";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Refuses to create containers on a shared daemon by accident.
 *
 * An unset host, a Unix socket, and a loopback TCP endpoint are local. Anything
 * else needs the explicit escape hatch. The production adapter currently uses
 * Unix sockets, but validating TCP-style values here keeps the guard honest if
 * that support is added later.
 */
export function assertLocalDockerHost(env: NodeJS.ProcessEnv = process.env): void {
  if (env.RIVET_ALLOW_REMOTE_SANDBOX === "1") return;

  const configured = env.DOCKER_HOST;
  if (!configured) return;
  if (configured.startsWith("unix://") || configured.startsWith("/")) return;

  let host: string;
  try {
    const parsed = new URL(configured.replace(/^tcp:\/\//, "http://"));
    host = parsed.hostname;
  } catch {
    throw new Error(`DOCKER_HOST is not a valid local Docker endpoint: ${configured}`);
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run the sandbox suite against Docker host ${host}: this suite creates, ` +
        "kills, and removes containers. Point DOCKER_HOST at a local daemon, or set " +
        "RIVET_ALLOW_REMOTE_SANDBOX=1 if you really mean it.",
    );
  }
}

export function describeDockerTarget(): string {
  const target = dockerConnectionTarget();
  return `${target.source}:${target.socketPath}`;
}
