import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PUBLIC_PAGES } from "./public-pages";

async function pageFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await pageFiles(path)));
    else if (entry.name === "page.tsx") files.push(path);
  }
  return files;
}

function pagePattern(appRoot: string, file: string): string {
  const path = relative(appRoot, file).replace(/\/page\.tsx$/, "");
  const segments = path.split("/").filter((segment) => !isRouteGroup(segment) && segment !== "");
  if (segments.length === 0) return "/";
  return (
    "/" +
    segments
      .map((segment) => (segment.startsWith("[") ? `:${segment.slice(1, -1)}` : segment))
      .join("/")
  );
}

function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

describe("page authentication coverage", () => {
  it("requires every page to guard itself or be explicitly public", async () => {
    const appRoot = resolve(import.meta.dirname, "../../app");
    const files = await pageFiles(appRoot);

    expect(files.length).toBeGreaterThan(5);
    expect([...PUBLIC_PAGES].sort()).toEqual(["/", "/sign-in"]);

    const seen = new Set<string>();
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const page = pagePattern(appRoot, file);
      seen.add(page);
      if (PUBLIC_PAGES.has(page)) {
        expect(source, page).not.toContain("requirePageSession");
      } else {
        expect(source, page).toContain("requirePageSession");
      }
    }

    for (const publicPage of PUBLIC_PAGES) {
      expect(seen.has(publicPage), `allowlisted ${publicPage} has no page.tsx`).toBe(true);
    }
  });
});
