import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EXPERIMENT_1 } from "@/lib/landing/experiment-1";

import LandingPage from "./page";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement("a", { href }, children),
}));

const LANDING_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(LANDING_DIR, "../..");
const IMPORT_RE = /from ["']([^"']+)["']/g;
const LOCAL_PREFIXES = ["@/components/landing/", "@/lib/landing/", "./", "../"];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("acceptance run A - landing page renders with no database", () => {
  it("is force-static and never imports the database or core", async () => {
    const files = await collectLocalModules(join(LANDING_DIR, "page.tsx"));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/@rivet\/core/);
      expect(source, file).not.toMatch(/@rivet\/database/);
    }
    const page = await readFile(join(LANDING_DIR, "page.tsx"), "utf8");
    expect(page).toContain('dynamic = "force-static"');
  });

  it("renders the Experiment 1 snapshot with DATABASE_URL unset", () => {
    vi.stubEnv("DATABASE_URL", "");
    delete process.env.DATABASE_URL;

    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain(EXPERIMENT_1.independent.successFraction);
    expect(html).toContain(EXPERIMENT_1.none.successFraction);
    expect(html).toContain("Sign in");
    expect(html).toContain("Why jobs instead of chat");
  });
});

async function collectLocalModules(entry: string): Promise<string[]> {
  const pending = [entry];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec || !LOCAL_PREFIXES.some((prefix) => spec.startsWith(prefix))) continue;
      const resolved = spec.startsWith("@/")
        ? join(WEB_ROOT, spec.slice(2))
        : resolve(dirname(file), spec);
      pending.push(await resolveSourceFile(resolved));
    }
  }
  return [...seen];
}

async function resolveSourceFile(base: string): Promise<string> {
  const candidates = [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")];
  if (base.endsWith(".ts") || base.endsWith(".tsx")) candidates.unshift(base);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`could not resolve landing import: ${base}`);
}
