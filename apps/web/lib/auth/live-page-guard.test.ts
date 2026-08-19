import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_PAGES } from "./public-pages";

/**
 * **Acceptance run B, the live half.**
 *
 * `pages.test.ts` is the static half: every `page.tsx` either sits in
 * `PUBLIC_PAGES` or mentions `requirePageSession`. That is coverage, and
 * coverage is not behaviour - a page can import the guard and never call it,
 * or call it after the read it was supposed to protect. So this file
 * **invokes** every non-public page with an unauthenticated request and
 * insists on a redirect.
 *
 * It runs in `pnpm test`, with no database, and that is load-bearing rather
 * than convenient. `DATABASE_URL` is unset here, so a page that touches
 * Postgres before it checks the session cannot redirect - it throws, and this
 * file fails. "Refuses before it reads" is therefore asserted by construction
 * rather than by reading the pages.
 */

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ toString: () => "" }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: (): never => {
    throw new Error("notFound");
  },
  useRouter: () => ({
    refresh: () => undefined,
    push: () => undefined,
  }),
}));

const SECRET = "a sufficiently long test session secret";

function githubMode(): void {
  vi.stubEnv("RIVET_AUTH", "github");
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "oauth-secret");
  vi.stubEnv("RIVET_OWNER_GITHUB_LOGIN", "owner");
  vi.stubEnv("RIVET_SESSION_SECRET", SECRET);
  vi.stubEnv("NODE_ENV", "test");
}

afterEach(() => vi.unstubAllEnvs());

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

const PAGE_CONTEXT = {
  params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }),
  searchParams: Promise.resolve({}),
};

type PageHandler = (context: typeof PAGE_CONTEXT) => Promise<unknown>;

describe("acceptance run B - every page redirects an unauthenticated visitor, live", () => {
  it("redirects to /sign-in from every non-public page, before any read", async () => {
    githubMode();
    vi.stubEnv("DATABASE_URL", "");
    delete process.env.DATABASE_URL;

    const appRoot = resolve(import.meta.dirname, "../../app");
    const files = await pageFiles(appRoot);
    expect(files.length).toBeGreaterThan(5);

    let invoked = 0;
    for (const file of files) {
      const pattern = pagePattern(appRoot, file);
      if (PUBLIC_PAGES.has(pattern)) continue;

      const module = (await import(file)) as Record<string, unknown>;
      for (const exportName of ["default", "generateMetadata"] as const) {
        const handler = module[exportName];
        if (typeof handler !== "function") continue;

        invoked += 1;
        await expect((handler as PageHandler)(PAGE_CONTEXT)).rejects.toThrow("REDIRECT:/sign-in");
      }
    }

    expect(invoked).toBeGreaterThan(5);
  });
});
