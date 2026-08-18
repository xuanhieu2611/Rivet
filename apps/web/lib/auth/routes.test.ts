import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PUBLIC_ROUTES } from "./guard";

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await routeFiles(path)));
    else if (entry.name === "route.ts") files.push(path);
  }
  return files;
}

function routePattern(apiRoot: string, file: string): string {
  const path = relative(apiRoot, file).replace(/\/route\.ts$/, "");
  return (
    "/api/" +
    path
      .split("/")
      .map((segment) => (segment.startsWith("[") ? `:${segment.slice(1, -1)}` : segment))
      .join("/")
  );
}

describe("API authentication coverage", () => {
  it("requires every API route to guard itself or be explicitly public", async () => {
    const apiRoot = resolve(import.meta.dirname, "../../app/api");
    const files = await routeFiles(apiRoot);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const route = routePattern(apiRoot, file);
      if (PUBLIC_ROUTES.has(route)) {
        expect(source, route).toContain("Public");
      } else {
        expect(source, route).toContain("requireSession");
      }
    }
  });
});
