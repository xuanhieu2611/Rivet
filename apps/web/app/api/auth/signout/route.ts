import "server-only";

import { NextResponse } from "next/server";

import { csrfFailure } from "@/lib/auth/csrf";
import { clearAuthCookies } from "@/lib/auth/session";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";

export const dynamic = "force-dynamic";

/** Public route: signs out by expiring the signed session cookie. */
export const POST = withRoute(
  "/api/auth/signout",
  async (request: Request, _telemetry: RouteTelemetry) => {
    await Promise.resolve();
    const csrf = csrfFailure(request);
    if (csrf) return csrf;

    const response = NextResponse.redirect(new URL("/sign-in?signed_out=1", request.url), 303);
    clearAuthCookies(response, process.env.NODE_ENV === "production");
    return response;
  },
);
