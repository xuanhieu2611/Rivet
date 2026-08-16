import "server-only";

import type { Repository } from "@rivet/contracts";
import { NextResponse } from "next/server";

import { badRequest, serverError } from "@/lib/api/responses";
import { githubAccess, githubErrorResponse, githubUnavailable } from "@/lib/github/client";
import { parseInstallationId } from "@/lib/github/params";

export const dynamic = "force-dynamic";

interface RepositoriesResponse {
  repositories: Repository[];
}

/** `GET /api/github/repositories?installationId=<id>` - what one installation reaches. */
export async function GET(request: Request) {
  const access = githubAccess();
  if (!access.enabled) return githubUnavailable(access.reason);

  const installationId = parseInstallationId(
    new URL(request.url).searchParams.get("installationId"),
  );
  if (installationId === undefined) {
    return badRequest("`installationId` must be a positive integer.");
  }

  try {
    const repositories = await access.client.listRepositories(installationId);
    return NextResponse.json({ repositories } satisfies RepositoriesResponse);
  } catch (cause) {
    return githubErrorResponse(cause) ?? serverError("GET /api/github/repositories", cause);
  }
}
