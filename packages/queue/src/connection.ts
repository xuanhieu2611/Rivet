import IORedis, { type Redis } from "ioredis";

/**
 * The shared ioredis client, created on first use.
 *
 * Same rule as `@rivet/database`, for the same reason: **importing this package
 * must never open a connection and must never throw.** `next build` runs in CI
 * with no `REDIS_URL` at all, and a module-scope `new IORedis(...)` would take
 * the build down. Every export here is a function, and the client is built
 * inside it.
 */

/**
 * Dev-mode module re-evaluation is the second trap.
 *
 * Next.js re-evaluates server modules on every hot reload, so a plain
 * module-level `let` gives you a fresh client per edit and leaks connections
 * until Upstash starts refusing them. Caching on `globalThis` - the same trick
 * people use for Prisma clients - survives the reload because the module
 * registry is what gets thrown away, not the global object.
 */
const globalForRedis = globalThis as unknown as { __rivetRedis?: Redis };

let client: Redis | undefined;

function connectionUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "REDIS_URL is not set. Copy .env.example to .env.local and fill in the " +
        "Upstash connection string.",
    );
  }
  return url;
}

export function getRedis(): Redis {
  client ??= globalForRedis.__rivetRedis;
  if (client) return client;

  const url = connectionUrl();
  client = new IORedis(url, {
    // BullMQ refuses to start a Worker on a connection that gives up on a
    // command, because its blocking pops legitimately outlive any retry budget.
    // This is not a tuning knob; it is a hard requirement of the library.
    maxRetriesPerRequest: null,
    // `rediss://` already implies TLS in ioredis. Upstash is TLS-only, so this
    // is belt and braces for the case where someone pastes an `redis://` URL
    // for a host that will only ever answer over TLS.
    ...(url.startsWith("rediss://") ? { tls: {} } : {}),
  });

  if (process.env.NODE_ENV !== "production") {
    globalForRedis.__rivetRedis = client;
  }
  return client;
}

/** Closes the shared client. Only entrypoints and scripts call this. */
export async function closeRedis(): Promise<void> {
  const current = client;
  client = undefined;
  delete globalForRedis.__rivetRedis;
  if (current) {
    // `quit` waits for in-flight commands; `disconnect` would drop them. A
    // worker shutting down has usually just written a status change.
    await current.quit();
  }
}
