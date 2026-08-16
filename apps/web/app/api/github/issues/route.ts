import "server-only";

import type { Issue } from "@rivet/contracts";
import { NextResponse } from "next/server";

import { badRequest, serverError } from "@/lib/api/responses";
import { githubAccess, githubErrorResponse, githubUnavailable } from "@/lib/github/client";
import { parseInstallationId, parseRepoRef } from "@/lib/github/params";

export const dynamic = "force-dynamic";

interface IssuesResponse {
  issues: Issue[];
}

/** `GET /api/github/issues?installationId=<id>&owner=<o>&name=<r>` - a repository's issues. */
export async function GET(request: Request) {
  const access = githubAccess();
  if (!access.enabled) return githubUnavailable(access.reason);

  const params = new URL(request.url).searchParams;
  const installationId = parseInstallationId(params.get("installationId"));
  if (installationId === undefined) {
    return badRequest("`installationId` must be a positive integer.");
  }

  const repo = parseRepoRef(params);
  if (!repo) return badRequest("`owner` and `name` are both required.");

  try {
    const issues = await access.client.listIssues(installationId, repo);
    return NextResponse.json({ issues } satisfies IssuesResponse);
  } catch (cause) {
    return githubErrorResponse(cause) ?? serverError("GET /api/github/issues", cause);
  }
}
