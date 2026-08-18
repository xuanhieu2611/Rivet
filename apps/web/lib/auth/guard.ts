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

  const session = await sessionFromRequest(request, config.sessionSecret);
  if (!session) {
    return NextResponse.json(
      { error: "Authentication required. Sign in with GitHub to continue." },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  return null;
}

export async function sessionFromRequest(
  request: Request,
  secret: string,
): Promise<RivetSession | null> {
  return readSessionToken(readCookieValue(request.headers.get("cookie"), SESSION_COOKIE), secret);
}
