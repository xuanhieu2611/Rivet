/**
 * Pages that must work before a session exists. Keep this list explicit.
 *
 * API guarding is `requireSession` plus `PUBLIC_ROUTES`. Page guarding is
 * `requirePageSession` plus this set. The Next.js proxy uses the same set, so
 * `/` (a redirect to the dashboard) and `/sign-in` run before any session
 * check. The two lists are allowed to disagree about mechanism; they are not
 * allowed to grow without a test noticing.
 */
export const PUBLIC_PAGES = new Set(["/", "/sign-in"]);

/**
 * Static files the proxy must let through without a session: a redirect to
 * `/sign-in` arrives as `Content-Type: null` and breaks the browser's request.
 */
export function isPublicStaticPath(pathname: string): boolean {
  return pathname === "/favicon.ico";
}
