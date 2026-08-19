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
