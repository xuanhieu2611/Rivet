import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Belt and braces. The integration suite lives under `tests/` and has its
    // own config, so this pattern already excludes it - but `pnpm test` must
    // run with no database and no Redis, and that is worth stating twice.
    exclude: ["**/node_modules/**", "**/*.int.test.ts", "**/*.sbx.test.ts"],
  },
});
