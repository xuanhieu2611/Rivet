/* eslint-disable no-console -- setup output belongs on the console */
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { repoRoot, resolveStreamingEnv } from "./env";

/**
 * Applies the committed schema before the streaming suite starts.
 *
 * This is deliberately separate from the worker integration setup. The two
 * suites both truncate shared job tables, so CI gives each one its own job and
 * a local run should execute them one at a time.
 */
export default async function setup(): Promise<void> {
  const databaseUrl = resolveStreamingEnv();

  console.log(`[streaming] postgres ${redact(databaseUrl)}`);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: join(repoRoot(), "packages/database/drizzle"),
    });
  } finally {
    await pool.end();
  }
}

/** Never print a connection string with credentials in it. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port}${parsed.pathname}`;
  } catch {
    return "(unparseable)";
  }
}
