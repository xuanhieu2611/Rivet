import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config as loadEnvFile } from "dotenv";

/** Matches the Postgres service container used by CI and the other DB suites. */
const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/rivet_test";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

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
 * Loads the streaming suite's database URL and refuses non-local databases by
 * default. Every streaming case truncates the job tables, so this guard must
 * run before the migration or any test can touch the database.
 */
export function resolveStreamingEnv(): string {
  // `.env.local` is intentionally not loaded. It points at the development
  // database on this machine, while `.env.test` is an opt-in local override.
  loadEnvFile({ path: join(repoRoot(), ".env.test"), quiet: true });

  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  assertLocal(databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  // There is no pooler in front of the local service, so migrations and test
  // queries intentionally use the same endpoint.
  process.env.DATABASE_URL_UNPOOLED = databaseUrl;

  return databaseUrl;
}

function assertLocal(value: string): void {
  if (process.env.RIVET_ALLOW_REMOTE_INTEGRATION === "1") return;

  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run the streaming suite against ${host}: this suite truncates ` +
        `jobs and job_events between tests. Point DATABASE_URL at a local Postgres ` +
        `(see .env.example and the streaming CI job in ci.yml), or set ` +
        `RIVET_ALLOW_REMOTE_INTEGRATION=1 if you really mean it.`,
    );
  }
}
