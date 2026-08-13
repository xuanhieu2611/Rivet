import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

/** The handle `db.transaction(async (tx) => ...)` hands its callback. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Anything that can run a query: the pooled client, or an open transaction.
 *
 * Service functions take this rather than `Database` so a caller inside a
 * transaction can pass `tx` and have the write join that transaction instead of
 * silently landing on a separate connection. That is what lets `transitionJob`
 * reuse `appendEvent` while still writing both rows atomically.
 */
export type Executor = Database | Transaction;

let pool: Pool | undefined;
let database: Database | undefined;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill in the " +
        "pooled Neon connection string.",
    );
  }
  return url;
}

/**
 * The shared `pg` pool, created on first use.
 *
 * This is the POOLED Neon endpoint. Migrations deliberately use the direct
 * endpoint instead - see `src/migrate.ts`.
 */
export function getPool(): Pool {
  pool ??= new Pool({ connectionString: connectionString() });
  return pool;
}

/**
 * The Drizzle client, created on first use.
 *
 * Construction is lazy so that merely importing `@rivet/database` never throws.
 * Typecheck, lint and unit-test runs have no `DATABASE_URL` and must not need one.
 */
export function getDb(): Database {
  database ??= drizzle(getPool(), { schema });
  return database;
}

/** Closes the pool. Only useful for scripts and tests; the app never calls it. */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  database = undefined;
  if (current) {
    await current.end();
  }
}

/**
 * Ergonomic handle that forwards every access to the lazily-created client.
 *
 * `import { db } from "@rivet/database"` stays a plain value at call sites while
 * the connection is still only opened on first real use.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property, _receiver) {
    const instance = getDb();
    const value: unknown = Reflect.get(instance, property, instance);
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(instance)
      : value;
  },
  has(_target, property) {
    return Reflect.has(getDb(), property);
  },
  ownKeys() {
    return Reflect.ownKeys(getDb());
  },
  getOwnPropertyDescriptor(_target, property) {
    const descriptor = Reflect.getOwnPropertyDescriptor(getDb(), property);
    return descriptor && { ...descriptor, configurable: true };
  },
});
