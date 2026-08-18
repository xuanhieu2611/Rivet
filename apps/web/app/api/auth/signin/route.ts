import "server-only";

import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

import {
  AUTH_UNCONFIGURED_MESSAGE,
  assertWebAuthModeAllowed,
  resolveWebAuthConfig,
} from "@/lib/auth/config";
import { setOAuthStateCookie } from "@/lib/auth/session";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";

export const dynamic = "force-dynamic";

/** Public route: starts GitHub's identifying OAuth flow. The App installation flow is separate. */
export const GET = withRoute(
  "/api/auth/signin",
  async (request: Request, _telemetry: RouteTelemetry) => {
    await Promise.resolve();
    const config = resolveWebAuthConfig();
    assertWebAuthModeAllowed(config.mode, process.env.NODE_ENV);
    if (config.mode === "off") return redirect(request, "/");
    if (!config.enabled) {
      return NextResponse.json({ error: AUTH_UNCONFIGURED_MESSAGE }, { status: 503 });
    }

    const state = randomBytes(32).toString("base64url");
    const callbackUrl = new URL("/api/auth/callback", request.url);
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", config.clientId);
    authorize.searchParams.set("redirect_uri", callbackUrl.toString());
    authorize.searchParams.set("scope", "read:user");
    authorize.searchParams.set("state", state);

    const response = NextResponse.redirect(authorize, 303);
    setOAuthStateCookie(response, state, process.env.NODE_ENV === "production");
    return response;
  },
);

function redirect(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), 303);
}
