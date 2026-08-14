import "server-only";

import { serializeJobArtifact } from "@rivet/contracts";
import { getArtifact, getJob } from "@rivet/core";
import { NextResponse } from "next/server";

import { badRequest, notFound, serverError } from "@/lib/api/responses";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; artifactId: string }>;
}

/** Artifact ids are positive, safe integers because they come from bigserial. */
function parseArtifactId(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** `GET /api/jobs/:id/artifacts/:artifactId` - one artifact with its content. */
export async function GET(_request: Request, context: RouteContext) {
  const { id, artifactId: rawArtifactId } = await context.params;
  const artifactId = parseArtifactId(rawArtifactId);
  if (artifactId === undefined) {
    return badRequest("`artifactId` must be a positive integer.");
  }

  try {
    const job = await getJob(id);
    if (!job) return notFound("Job not found.");

    const artifact = await getArtifact(id, artifactId);
    if (!artifact) return notFound("Artifact not found.");

    return NextResponse.json(serializeJobArtifact(artifact));
  } catch (cause) {
    return serverError("GET /api/jobs/:id/artifacts/:artifactId", cause);
  }
}
