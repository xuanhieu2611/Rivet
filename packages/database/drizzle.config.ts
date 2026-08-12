import { defineConfig } from "drizzle-kit";

import { loadRootEnv, migrationConnectionString } from "./load-env";

loadRootEnv();

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: migrationConnectionString() },
  strict: true,
  verbose: true,
});
