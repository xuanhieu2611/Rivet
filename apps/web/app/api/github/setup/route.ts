import "server-only";

import { syncGitHubInstallation } from "@rivet/core";
import { NextResponse } from "next/server";

import { githubAccess, githubUnavailable } from "@/lib/github/client";
import { parseInstallationId } from "@/lib/github/params";

export const dynamic = "force-dynamic";

/**
 * `GET /api/github/setup` - the App's post-install landing URL.
 *
 * GitHub redirects here with `installation_id` and `setup_action` after somebody
 * installs or reconfigures the App. The id in the query string is not trusted:
 * the handler lists the installations this App can actually act on and persists
 * the row only if the callback's id is among them, so a hand-typed URL cannot
 * fabricate an installation Rivet then offers as a publication target.
 *
 * Every outcome ends at `/settings/github` with a status in the query string
 * rather than as a JSON body, because a person's browser is what lands here.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const settings = (status: string) =>
    NextResponse.redirect(new URL(`/settings/github?setup=${status}`, url), 303);

  const access = githubAccess();
  if (!access.enabled) return githubUnavailable(access.reason);

  // `setup_action=request` means an organization admin still has to approve the
  // install. There is no installation to record yet, and saying so is the whole
  // response.
  if (url.searchParams.get("setup_action") === "request") {
    return settings("requested");
  }

  const installationId = parseInstallationId(url.searchParams.get("installation_id"));
  if (installationId === undefined) return settings("invalid");

  try {
    const installation = await syncGitHubInstallation(access.client, installationId);
    return settings(installation ? "installed" : "unknown");
  } catch (cause) {
    console.error("[GET /api/github/setup]", cause);
    return settings("failed");
  }
}
