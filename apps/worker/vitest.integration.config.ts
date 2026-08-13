import { defineConfig } from "vitest/config";

/**
 * The integration suite: real Postgres, real Redis, real BullMQ workers.
 *
 * Kept in a separate config rather than behind a tag so that `pnpm test` cannot
 * accidentally pick it up. The default suite has to stay runnable with no
 * database and no Redis - that is what CI's `verify` job proves on every push -
 * and the surest way to keep that true is for the two suites to have no file
 * pattern in common.
 *
 * `fileParallelism: false` is not a performance concession, it is correctness:
 * every file truncates `jobs` and `job_events` between tests, so two files
 * running at once would delete each other's rows. Queue names are per-file for
 * the same reason on the Redis side, where a unique name is enough because
 * nothing there is global.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.int.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    // Generous: several of these deliberately wait out a real lease expiry.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
