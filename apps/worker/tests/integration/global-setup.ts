/* eslint-disable no-console -- setup output belongs on the console */
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { repoRoot, resolveIntegrationEnv } from "./env";

/**
 * Runs once before the whole integration suite.
 *
 * Two jobs: settle which database and Redis the suite is allowed to touch (see
 * `env.ts`, which is where the interesting rule lives), and bring the schema up
 * to date. Migrations are applied here rather than in a CI step so that a local
 * `pnpm test:integration` needs exactly one command and cannot run against a
 * schema that is a migration behind.
 *
 * The same `drizzle/` folder and the same migrator as `pnpm db:migrate`, on
 * purpose: a suite that built its schema some other way would be testing a
 * schema that no deployment has.
 */
export default async function setup(): Promise<void> {
  const { databaseUrl, redisUrl } = resolveIntegrationEnv();

  console.log(`[integration] postgres ${redact(databaseUrl)}`);
  console.log(`[integration] redis    ${redact(redisUrl)}`);

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
