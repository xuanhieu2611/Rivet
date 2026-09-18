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

/**
 * The signed-in login, for the header.
 *
 * Presentation only, and deliberately not a second guard: it returns `null`
 * under `RIVET_AUTH=off` and for any cookie the allowlist no longer accepts,
 * so the header simply shows nothing rather than claiming an identity. The
 * page redirect above and the API guards remain the authoritative checks, and
 * this re-runs the same owner comparison rather than trusting the signature -
 * that re-check at use time is the only revocation mechanism the system has.
 */
export async function readPageSessionLogin(): Promise<string | null> {
  const config = resolveWebAuthConfig();
  if (config.mode === "off" || config.enabled !== true) return null;

  const cookieHeader = (await cookies()).toString();
  const session = await readSessionToken(
    readCookieValue(cookieHeader, SESSION_COOKIE),
    config.sessionSecret,
  );
  if (!session) return null;

  return session.githubLogin.toLowerCase() === config.ownerGithubLogin.toLowerCase()
    ? session.githubLogin
    : null;
}
