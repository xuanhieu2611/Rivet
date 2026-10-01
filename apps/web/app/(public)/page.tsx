import { redirect } from "next/navigation";

/**
 * The public introduction to Rivet is `apps/site`, a static export hosted
 * separately. This app is the local operator surface, and its front door is
 * the dashboard, whose own page guard sends a visitor without a session on to
 * `/sign-in`.
 *
 * `/` stays in `PUBLIC_PAGES` because this redirect reads nothing; keeping it
 * public means signing in and following `next=/` can never loop.
 */
export default function RootPage(): never {
  redirect("/jobs");
}
