import "server-only";

import { serializeJobArtifactSummary, type SerializedJobArtifactSummary } from "@rivet/contracts";
import { getJob, listArtifacts } from "@rivet/core";
import { NextResponse } from "next/server";

import { badRequest, notFound, serverError } from "@/lib/api/responses";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ArtifactsResponse {
  artifacts: SerializedJobArtifactSummary[];
  cursor: number | null;
}

/** `?after=` must be a non-negative integer artifact id. */
function parseAfter(raw: string | null): number | null | undefined {
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

/** `GET /api/jobs/:id/artifacts?after=<id>` - artifact metadata, oldest first. */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;

  const after = parseAfter(new URL(request.url).searchParams.get("after"));
  if (after === undefined) {
    return badRequest("`after` must be a non-negative integer artifact id.");
  }

  try {
    const job = await getJob(id);
    if (!job) return notFound("Job not found.");

    const artifacts = await listArtifacts(id, after === null ? {} : { after });
    const body: ArtifactsResponse = {
      artifacts: artifacts.map(serializeJobArtifactSummary),
      cursor: artifacts.at(-1)?.id ?? after,
    };
    return NextResponse.json(body);
  } catch (cause) {
    return serverError("GET /api/jobs/:id/artifacts", cause);
  }
}
