/**
 * Pages that must work before a session exists. Keep this list explicit.
 *
 * API guarding is `requireSession` plus `PUBLIC_ROUTES`. Page guarding is
 * `requirePageSession` plus this set. The Next.js proxy uses the same set, so
 * an unauthenticated visitor actually reaches `/` instead of bouncing to
 * `/sign-in` before the page runs. The two lists are allowed to disagree about
 * mechanism; they are not allowed to grow without a test noticing.
 */
export const PUBLIC_PAGES = new Set(["/", "/sign-in"]);

/**
 * Files under `public/` that the landing page serves. The proxy must let these
 * through: Next's image optimizer fetches them without a session cookie, and a
 * redirect to `/sign-in` arrives as `Content-Type: null`.
 */
export function isPublicStaticPath(pathname: string): boolean {
  return pathname === "/favicon.ico" || pathname.startsWith("/landing/");
}
