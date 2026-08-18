import "server-only";

import type { Installation } from "@rivet/contracts";
import { syncGitHubInstallations } from "@rivet/core";
import { NextResponse } from "next/server";

import { serverError } from "@/lib/api/responses";
import { githubAccess, githubErrorResponse, githubUnavailable } from "@/lib/github/client";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";

export const dynamic = "force-dynamic";

interface InstallationsResponse {
  installations: Installation[];
}

/**
 * `GET /api/github/installations` - every installation this App can act on.
 *
 * Reads from GitHub rather than from `github_installations`, and refreshes the
 * table with what it learns. Milestone 9 subscribes to no webhooks, so pulling
 * on demand is the only way an uninstall or a permission change ever becomes
 * visible; the table is the durable copy, not the source of truth.
 */
export const GET = withRoute(
  "/api/github/installations",
  async (_request: Request, telemetry: RouteTelemetry) => {
    const access = githubAccess();
    if (!access.enabled) return githubUnavailable(access.reason);

    try {
      const installations = await syncGitHubInstallations(access.client);
      return NextResponse.json({ installations } satisfies InstallationsResponse);
    } catch (cause) {
      return (
        githubErrorResponse(cause) ??
        serverError("GET /api/github/installations", cause, telemetry.log)
      );
    }
  },
);
