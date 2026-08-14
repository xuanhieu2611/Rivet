import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

/**
 * The real-Postgres SSE suite. It has its own config so the ordinary unit
 * suite remains infrastructure-free and cannot truncate a developer database.
 */
export default defineConfig({
  resolve: {
    alias: { "@": root },
  },
  test: {
    environment: "node",
    include: ["tests/streaming/**/*.stream.test.ts"],
    globalSetup: ["tests/streaming/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
