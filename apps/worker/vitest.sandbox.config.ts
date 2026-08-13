import { defineConfig } from "vitest/config";

/**
 * The sandbox suite: real Docker, Postgres, Redis, and BullMQ.
 *
 * Its file pattern overlaps neither the unit nor integration suite. This keeps
 * `pnpm test` daemon-free and the ordinary integration suite Docker-free.
 * Docker and database state are shared resources, so files run serially.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.sbx.test.ts"],
    globalSetup: ["tests/sandbox/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
