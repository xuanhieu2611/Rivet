import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_ROUTES, requireSession } from "./guard";
import { createSessionToken, SESSION_COOKIE } from "./session";

/**
 * **Acceptance run E, the live half.**
 *
 * `routes.test.ts` is the static half: every `route.ts` either sits in
 * `PUBLIC_ROUTES` or mentions `requireSession`. That is coverage, and coverage
 * is not behaviour - a route can import the guard and never call it, or call it
 * after the read it was supposed to protect. So this file **invokes** every
 * non-public handler with an unauthenticated request and insists on a refusal.
 *
 * It runs in `pnpm test`, with no database, and that is load-bearing rather
 * than convenient. `DATABASE_URL` is unset here, so a handler that touches
 * Postgres before it checks the session cannot answer 401 - it throws, and this
 * file fails. "Refuses before it reads" is therefore asserted by construction
 * rather than by reading the handlers.
 */

// Route modules are server modules and say so. Under vitest that import
// resolves to the client build, which exists only to throw.
vi.mock("server-only", () => ({}));

const SECRET = "a sufficiently long test session secret";
const ISSUER = "rivet";
const AUDIENCE = "rivet-web";

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

function githubMode(): void {
  vi.stubEnv("RIVET_AUTH", "github");
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "oauth-secret");
  vi.stubEnv("RIVET_OWNER_GITHUB_LOGIN", "owner");
  vi.stubEnv("RIVET_SESSION_SECRET", SECRET);
  vi.stubEnv("NODE_ENV", "test");
}

afterEach(() => vi.unstubAllEnvs());

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

/** `/api/jobs/[id]/events` becomes `/api/jobs/:id/events`, matching `PUBLIC_ROUTES`. */
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

/** A concrete URL for a pattern, since a handler is entitled to parse its own path. */
function concreteUrl(pattern: string): string {
  return (
    "http://localhost" +
    pattern
      .split("/")
      .map((segment) =>
        segment.startsWith(":") ? "00000000-0000-4000-8000-000000000000" : segment,
      )
      .join("/")
  );
}

/** The `{ params }` context Next hands a dynamic route, filled with the same id. */
function routeContext(pattern: string): { params: Promise<Record<string, string>> } {
  const params: Record<string, string> = {};
  for (const segment of pattern.split("/")) {
    if (segment.startsWith(":")) params[segment.slice(1)] = "00000000-0000-4000-8000-000000000000";
  }
  return { params: Promise.resolve(params) };
}

type Handler = (request: Request, context: unknown) => Promise<Response> | Response;

describe("acceptance run E - every route refuses an unauthenticated caller, live", () => {
  it("returns 401 or a redirect from every non-public handler, before any read", async () => {
    githubMode();
    const apiRoot = resolve(import.meta.dirname, "../../app/api");
    const files = await routeFiles(apiRoot);
    expect(files.length).toBeGreaterThan(0);

    let invoked = 0;
    for (const file of files) {
      const pattern = routePattern(apiRoot, file);
      if (PUBLIC_ROUTES.has(pattern)) continue;

      const module = (await import(file)) as Record<string, unknown>;
      for (const method of METHODS) {
        const handler = module[method];
        if (typeof handler !== "function") continue;

        const request = new Request(concreteUrl(pattern), {
          method,
          ...(method === "GET"
            ? {}
            : { headers: { "content-type": "application/json" }, body: "{}" }),
        });
        const response = await (handler as Handler)(request, routeContext(pattern));

        invoked += 1;
        expect(
          response.status === 401 || (response.status >= 300 && response.status < 400),
          `${method} ${pattern} answered ${response.status} without a session`,
        ).toBe(true);
      }
    }

    // The positive control. A loop that matched nothing - a renamed directory,
    // a changed file name - would pass silently, which is the one way a
    // coverage test can be worse than no test.
    expect(invoked).toBeGreaterThan(10);
  });

  it("refuses an expired session", async () => {
    githubMode();
    const expired = await new SignJWT({ login: "owner" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("owner")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 60 * 60)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));

    const response = await requireSession(
      new Request("http://localhost/api/jobs", {
        headers: { cookie: `${SESSION_COOKIE}=${expired}` },
      }),
    );

    expect(response?.status).toBe(401);

    // The positive control: the same claims, unexpired, are accepted. Without
    // it this case passes against a guard that rejects every token it is given.
    const valid = await createSessionToken("owner", SECRET);
    await expect(
      requireSession(
        new Request("http://localhost/api/jobs", {
          headers: { cookie: `${SESSION_COOKIE}=${valid}` },
        }),
      ),
    ).resolves.toBeNull();
  });

  it("refuses a session signed with another secret while accepting the real one", async () => {
    githubMode();
    const forged = await createSessionToken("owner", "a different but equally long secret value");
    const genuine = await createSessionToken("owner", SECRET);

    const refused = await requireSession(
      new Request("http://localhost/api/jobs", {
        headers: { cookie: `${SESSION_COOKIE}=${forged}` },
      }),
    );
    const accepted = await requireSession(
      new Request("http://localhost/api/jobs", {
        headers: { cookie: `${SESSION_COOKIE}=${genuine}` },
      }),
    );

    expect(refused?.status).toBe(401);
    expect(accepted).toBeNull();
  });
});
