import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config as loadEnvFile } from "dotenv";

/**
 * Where the integration suite is allowed to point, and how it finds out.
 *
 * The important rule in this file is the guard at the bottom. Every test in the
 * suite truncates `jobs` and `job_events` between cases, so the one thing that
 * must never happen is the suite running against the Neon database in
 * `.env.local`. That is not a hypothetical: `.env.local` is present on every
 * developer machine, most tooling in this repo loads it automatically, and the
 * failure mode is silent and total.
 *
 * So this file deliberately does NOT load `.env.local`. It reads `.env.test` if
 * one exists, falls back to the same localhost defaults CI's service containers
 * use, and then refuses to run against anything that is not obviously local.
 */

/** Matches CI's `postgres:17` service container. */
const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/rivet_test";
/** Matches CI's `redis:8` service container. */
const DEFAULT_REDIS_URL = "redis://localhost:6379";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres", "redis"]);

export function repoRoot(from: string = import.meta.dirname): string {
  let directory = resolve(from);
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not locate the repo root above ${from}.`);
    }
    directory = parent;
  }
}

/**
 * Resolves and validates the suite's two connection strings.
 *
 * Called from `globalSetup`, so a misconfigured run fails once, loudly, before
 * a single test has had the chance to truncate anything.
 */
export function resolveIntegrationEnv(): { databaseUrl: string; redisUrl: string } {
  // Values already in the environment win, which is how CI supplies them.
  loadEnvFile({ path: join(repoRoot(), ".env.test"), quiet: true });

  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const redisUrl = process.env.REDIS_URL ?? DEFAULT_REDIS_URL;

  assertLocal("DATABASE_URL", databaseUrl);
  assertLocal("REDIS_URL", redisUrl);

  process.env.DATABASE_URL = databaseUrl;
  // Migrations run through the direct endpoint when it is set. There is no
  // pooler in front of a container, so both point at the same place - but it
  // has to be set explicitly, or a stray `DATABASE_URL_UNPOOLED` in the
  // environment would send the migration somewhere else entirely.
  process.env.DATABASE_URL_UNPOOLED = databaseUrl;
  process.env.REDIS_URL = redisUrl;

  return { databaseUrl, redisUrl };
}

/**
 * Refuses anything that is not plainly a local container.
 *
 * The escape hatch exists because "local" is a heuristic and someone will
 * eventually have a good reason to point this at a throwaway remote database.
 * Making them say so out loud is the entire mechanism.
 */
function assertLocal(name: string, value: string): void {
  if (process.env.RIVET_ALLOW_REMOTE_INTEGRATION === "1") return;

  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run the integration suite against ${host}: this suite truncates ` +
        `jobs and job_events between tests. Point ${name} at a local Postgres and ` +
        `Redis (see .env.example and the integration job in ci.yml), or set ` +
        `RIVET_ALLOW_REMOTE_INTEGRATION=1 if you really mean it.`,
    );
  }
}
