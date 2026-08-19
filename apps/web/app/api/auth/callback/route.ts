import "server-only";

import { NextResponse } from "next/server";
import { getRateLimiter, RateLimitUnavailableError } from "@rivet/queue";

import {
  AUTH_UNCONFIGURED_MESSAGE,
  assertWebAuthModeAllowed,
  resolveWebAuthConfig,
} from "@/lib/auth/config";
import {
  clearOAuthStateCookie,
  createSessionToken,
  OAUTH_STATE_COOKIE,
  readCookieValue,
  setSessionCookie,
} from "@/lib/auth/session";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";
import { resolveWebRateLimitConfig } from "@/lib/rate-limit/config";
import { requestAddress, rateLimitKey } from "@/lib/rate-limit/request";
import { rateLimitExceeded, rateLimitUnavailable } from "@/lib/rate-limit/response";

export const dynamic = "force-dynamic";

/** Public route: completes OAuth, identifies the one configured owner, and creates a session. */
export const GET = withRoute(
  "/api/auth/callback",
  async (request: Request, telemetry: RouteTelemetry) => {
    const config = resolveWebAuthConfig();
    assertWebAuthModeAllowed(config.mode, process.env.NODE_ENV);
    if (config.mode === "off") return redirect(request, "/jobs");
    if (!config.enabled) {
      return NextResponse.json({ error: AUTH_UNCONFIGURED_MESSAGE }, { status: 503 });
    }

    const rateLimits = resolveWebRateLimitConfig();
    try {
      const result = await getRateLimiter().consume(
        rateLimitKey("oauth", requestAddress(request)),
        rateLimits.unauthenticatedLimit,
        rateLimits.unauthenticatedWindowMs,
      );
      if (!result.allowed) {
        return rateLimitExceeded(
          "unauthenticated OAuth requests",
          rateLimits.unauthenticatedLimit,
          result,
        );
      }
    } catch (cause) {
      if (!(cause instanceof RateLimitUnavailableError)) throw cause;
      return rateLimitUnavailable();
    }

    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const expectedState = readCookieValue(request.headers.get("cookie"), OAUTH_STATE_COOKIE);
    if (!state || !expectedState || state !== expectedState) {
      return authFailure(request, "The GitHub sign-in state was missing or expired.", 400);
    }

    const code = url.searchParams.get("code");
    if (!code) return authFailure(request, "GitHub did not return an authorization code.", 400);

    try {
      const callbackUrl = new URL("/api/auth/callback", request.url);
      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: callbackUrl.toString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenBody = (await tokenResponse.json().catch(() => null)) as {
        access_token?: unknown;
        error_description?: unknown;
      } | null;
      const accessToken =
        typeof tokenBody?.access_token === "string" ? tokenBody.access_token : null;
      if (!tokenResponse.ok || !accessToken) {
        return authFailure(
          request,
          typeof tokenBody?.error_description === "string"
            ? tokenBody.error_description
            : "GitHub rejected the sign-in request.",
          502,
        );
      }

      const identityResponse = await fetch("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "Rivet",
        },
        signal: AbortSignal.timeout(10_000),
      });
      const identity = (await identityResponse.json().catch(() => null)) as {
        login?: unknown;
      } | null;
      const login = typeof identity?.login === "string" ? identity.login : null;
      if (!identityResponse.ok || !login) {
        return authFailure(request, "GitHub did not return a usable account identity.", 502);
      }

      if (login.toLowerCase() !== config.ownerGithubLogin.toLowerCase()) {
        return authFailure(request, "This GitHub account is not allowed to use Rivet.", 403);
      }

      const token = await createSessionToken(login, config.sessionSecret);
      const response = redirect(request, "/jobs");
      // Expire the one-time OAuth state, but preserve the newly issued session.
      clearOAuthStateCookie(response, process.env.NODE_ENV === "production");
      setSessionCookie(response, token, process.env.NODE_ENV === "production");
      return response;
    } catch (cause) {
      telemetry.log.error({ err: cause }, "GitHub OAuth callback failed");
      return authFailure(request, "GitHub could not complete sign-in right now.", 502);
    }
  },
);

function authFailure(request: Request, message: string, status: number): NextResponse {
  const response = NextResponse.json({ error: message }, { status });
  clearOAuthStateCookie(response, process.env.NODE_ENV === "production");
  return response;
}

function redirect(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), 303);
}
