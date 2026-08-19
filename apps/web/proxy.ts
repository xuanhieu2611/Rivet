import { NextResponse, type NextRequest } from "next/server";

import { isPublicStaticPath, PUBLIC_PAGES } from "./lib/auth/public-pages";
import { assertWebAuthModeAllowed, resolveWebAuthConfig } from "./lib/auth/config";

/**
 * Redirect page navigation before it reaches a data-reading server component.
 * API handlers still call requireSession themselves; this proxy is not the auth
 * boundary because a route must not depend on it being present.
 */
export function proxy(request: NextRequest): NextResponse {
  const config = resolveWebAuthConfig();
  assertWebAuthModeAllowed(config.mode, process.env.NODE_ENV);

  if (
    config.mode === "off" ||
    PUBLIC_PAGES.has(request.nextUrl.pathname) ||
    isPublicStaticPath(request.nextUrl.pathname)
  ) {
    return NextResponse.next();
  }

  if (!config.enabled || !request.cookies.has("rivet_session")) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|landing/).*)"],
};
