/* eslint-disable no-console -- this file is a CLI entry point */
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { loadRootEnv, migrationConnectionString } from "../load-env";

/**
 * Applies every pending migration in `drizzle/`.
 *
 * Runs against whatever `DATABASE_URL_UNPOOLED` (preferred) or `DATABASE_URL`
 * points at, so the same command serves local development and the ephemeral
 * Neon branch CI creates per pull request.
 */
async function main(): Promise<void> {
  loadRootEnv();

  const pool = new Pool({ connectionString: migrationConnectionString(), max: 1 });
  try {
    const migrationsFolder = join(import.meta.dirname, "..", "drizzle");
    console.log(`Applying migrations from ${migrationsFolder} ...`);
    await migrate(drizzle(pool), { migrationsFolder });
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Never print the connection string - it embeds credentials.
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
