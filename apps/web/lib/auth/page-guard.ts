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
  const session = await readSessionToken(token, config.sessionSecret);
  // Same allowlist re-check the API guard performs: a signature that is still
  // valid is not a decision about who is currently allowed in.
  if (session?.githubLogin.toLowerCase() !== config.ownerGithubLogin.toLowerCase()) {
    redirect("/sign-in");
  }
}
