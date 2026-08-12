import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config } from "dotenv";

/**
 * Env loading for standalone tooling only.
 *
 * `src/client.ts` deliberately does NOT use this: Next.js loads `.env.local`
 * itself, and the worker in Milestone 1 gets its env from its process manager.
 * Only drizzle-kit and the migrate script, which run as bare Node processes,
 * need to read the files themselves.
 */

/** Walks up from `start` until the pnpm workspace root is found. */
function findRepoRoot(start: string): string {
  let directory = resolve(start);
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not locate the repo root (no pnpm-workspace.yaml above ${start}).`);
    }
    directory = parent;
  }
}

/**
 * Loads `.env.local` then `.env` from the repo root.
 *
 * Variables already present in `process.env` always win, so CI can hand a
 * connection string in directly and these files are simply ignored.
 */
export function loadRootEnv(): void {
  const root = findRepoRoot(process.cwd());
  config({ path: [join(root, ".env.local"), join(root, ".env")], quiet: true });
}

/**
 * The connection string DDL runs against.
 *
 * Prefers the direct endpoint, because DDL through Neon's PgBouncer in
 * transaction pooling mode is unreliable. Falls back to `DATABASE_URL` so CI can
 * point migrations at an ephemeral Neon branch with a single variable.
 */
export function migrationConnectionString(): string {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Neither DATABASE_URL_UNPOOLED nor DATABASE_URL is set. Copy .env.example " +
        "to .env.local and fill in the Neon connection strings.",
    );
  }
  return url;
}
