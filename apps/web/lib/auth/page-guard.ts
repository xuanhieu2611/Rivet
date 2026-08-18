import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { assertWebAuthModeAllowed, resolveWebAuthConfig } from "./config";
import { readCookieValue, readSessionToken, SESSION_COOKIE } from "./session";

/** Page redirects are convenience and defense in depth; API guards remain authoritative. */
export async function requirePageSession(): Promise<void> {
  const config = resolveWebAuthConfig();
  assertWebAuthModeAllowed(config.mode, process.env.NODE_ENV);
  if (config.mode === "off") return;
  if (!config.enabled) redirect("/sign-in");

  const cookieHeader = (await cookies()).toString();
  const token = readCookieValue(cookieHeader, SESSION_COOKIE);
  if (!(await readSessionToken(token, config.sessionSecret))) redirect("/sign-in");
}
