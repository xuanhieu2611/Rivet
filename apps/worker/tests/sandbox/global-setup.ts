/* eslint-disable no-console -- setup output belongs on the console */
import { join } from "node:path";

import { getDocker } from "@rivet/sandbox";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { repoRoot, resolveIntegrationEnv } from "../integration/env";
import { assertLocalDockerHost, describeDockerTarget } from "./env";

/** Validates every destructive dependency before a test can touch it. */
export default async function setup(): Promise<void> {
  assertLocalDockerHost();
  const { databaseUrl, redisUrl } = resolveIntegrationEnv();

  console.log(`[sandbox] docker   ${describeDockerTarget()}`);
  console.log(`[sandbox] postgres ${redact(databaseUrl)}`);
  console.log(`[sandbox] redis    ${redact(redisUrl)}`);

  await getDocker().ping();

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: join(repoRoot(), "packages/database/drizzle"),
    });
  } finally {
    await pool.end();
  }
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port}${parsed.pathname}`;
  } catch {
    return "(unparseable)";
  }
}
