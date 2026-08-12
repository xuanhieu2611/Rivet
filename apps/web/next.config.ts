import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config as loadEnvFile } from "dotenv";
import type { NextConfig } from "next";

/**
 * Rivet keeps a single `.env.local` at the repo root so the web app, drizzle-kit
 * and the Milestone 1 worker all read one file. Next.js only looks inside its own
 * project directory, so load the root file here - `next.config.ts` is evaluated by
 * the same Node process that serves the app, in dev, build and `next start` alike.
 *
 * Values already in `process.env` win, so CI and hosting platforms are unaffected.
 */
function loadRootEnv(): void {
  let directory = resolve(import.meta.dirname);
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      loadEnvFile({ path: [join(directory, ".env.local"), join(directory, ".env")], quiet: true });
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

loadRootEnv();

/**
 * No `transpilePackages` entry for `@rivet/database` / `@rivet/contracts`.
 *
 * Both are consumed as raw workspace TypeScript (their `main` points at
 * `src/index.ts`), which historically needed transpiling. Turbopack in Next 16
 * compiles linked workspace sources on both the server and the client without
 * it - verified by building and running the app with the option removed - so
 * carrying it would be cargo cult.
 *
 * Also note the absence of `runtime = "edge"` anywhere in this app: the database
 * client is a `pg` Pool and must have the Node.js runtime.
 */
const nextConfig: NextConfig = {
  // Next 16 writes its own AGENTS.md / CLAUDE.md into the app directory on
  // `next dev`. Rivet documents itself in `docs/`, so opt out.
  agentRules: false,
};

export default nextConfig;
