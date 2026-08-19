/**
 * The check every Docker-mode demo needs before it spends anything.
 *
 * M11's startup probe refuses to boot a worker whose `DATABASE_URL` or
 * `REDIS_URL` can be reached from inside a sandbox container, and a managed
 * endpoint - Neon, Upstash - is reachable from everywhere by construction.
 * That refusal is correct and is not something to work around: a container
 * running arbitrary cloned code would be one connection string away from the
 * database holding every job.
 *
 * What it is not is self-explanatory. The worker's own message says "bind
 * control-plane services to loopback", which is sound advice about a local
 * Postgres and impossible advice about Neon, and it arrives after the demo has
 * created a job and started a worker. So the demos check the same fact
 * themselves, first, and say the thing that actually helps: point at a local
 * control plane for this run.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres", "redis"]);

export function assertLocalControlPlane(command: string, env = process.env): void {
  if (env.RIVET_SANDBOX === "off") return;

  const remote = (["DATABASE_URL", "REDIS_URL"] as const).filter((name) => {
    const value = env[name];
    if (!value) return false;
    try {
      return !LOCAL_HOSTS.has(new URL(value).hostname);
    } catch {
      return false;
    }
  });
  if (remote.length === 0) return;

  throw new Error(
    `${command} runs a real container, and ${remote.join(" and ")} ` +
      `${remote.length === 1 ? "points" : "point"} at a remote host that the container can ` +
      "reach. The worker's startup probe will refuse to boot rather than expose the control " +
      "plane to cloned code.\n\n" +
      "Point this run at a local control plane - the same one the test suites use:\n\n" +
      "  brew services start postgresql@17\n" +
      '  redis-server --port 6379 --daemonize yes --save "" --appendonly no\n' +
      `  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rivet_dev \\\n` +
      `    DATABASE_URL_UNPOOLED=postgresql://postgres:postgres@localhost:5432/rivet_dev \\\n` +
      `    REDIS_URL=redis://localhost:6379 ${command}\n\n` +
      "Run pnpm db:migrate against the same URL once before the first demo.",
  );
}
