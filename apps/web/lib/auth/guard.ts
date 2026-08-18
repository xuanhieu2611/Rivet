import { NextResponse } from "next/server";

import {
  AUTH_UNCONFIGURED_MESSAGE,
  assertWebAuthModeAllowed,
  resolveWebAuthConfig,
} from "./config";
import { readCookieValue, readSessionToken, SESSION_COOKIE, type RivetSession } from "./session";

/** Routes that must work before a session exists. Keep this list explicit. */
export const PUBLIC_ROUTES = new Set([
  "/api/auth/signin",
  "/api/auth/callback",
  "/api/auth/signout",
  "/api/github/setup",
]);

export async function requireSession(request: Request): Promise<Response | null> {
  const config = resolveWebAuthConfig();
  assertWebAuthModeAllowed(config.mode, process.env.NODE_ENV);

  if (config.mode === "off") return null;
  if (!config.enabled) {
    return NextResponse.json({ error: AUTH_UNCONFIGURED_MESSAGE }, { status: 503 });
  }

  const session = await authorizedSession(request, config.sessionSecret, config.ownerGithubLogin);
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required. Sign in with GitHub to continue." },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  return null;
}

/**
 * Returns the authenticated principal for spend-shaped operations.
 * Authentication is intentionally one-owner today, but using the signed login
 * here keeps the key correct if the allowlist grows before the schema does.
 */
export async function authenticatedPrincipal(request: Request): Promise<string | null> {
  const config = resolveWebAuthConfig();
  assertWebAuthModeAllowed(config.mode, process.env.NODE_ENV);
  if (config.mode === "off") return "local-owner";
  if (!config.enabled) return null;

  const session = await authorizedSession(request, config.sessionSecret, config.ownerGithubLogin);
  return session?.githubLogin.toLowerCase() ?? null;
}

export async function sessionFromRequest(
  request: Request,
  secret: string,
): Promise<RivetSession | null> {
  return readSessionToken(readCookieValue(request.headers.get("cookie"), SESSION_COOKIE), secret);
}

/**
 * A valid signature is not by itself an authorization decision.
 *
 * The OAuth callback checks the allowlist against GitHub's answer at sign-in,
 * but a session lives for a week and there is no session table to revoke rows
 * from. Re-comparing the signed login against the currently configured owner on
 * every request is what makes changing `RIVET_OWNER_GITHUB_LOGIN` take effect
 * immediately rather than at the old session's expiry.
 */
export async function authorizedSession(
  request: Request,
  secret: string,
  ownerGithubLogin: string,
): Promise<RivetSession | null> {
  const session = await sessionFromRequest(request, secret);
  if (!session) return null;
  return session.githubLogin.toLowerCase() === ownerGithubLogin.toLowerCase() ? session : null;
}
