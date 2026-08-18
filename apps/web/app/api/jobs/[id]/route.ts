import "server-only";

import { getJob } from "@rivet/core";
import { NextResponse } from "next/server";

import { notFound, serverError } from "@/lib/api/responses";
import { requireSession } from "@/lib/auth/guard";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET /api/jobs/:id` - 404 when the id is unknown or not a uuid. */
export const GET = withRoute(
  "/api/jobs/:id",
  async (request: Request, telemetry: RouteTelemetry, context: RouteContext) => {
    const auth = await requireSession(request);
    if (auth) return auth;

    const { id } = await context.params;
    try {
      const job = await getJob(id);
      if (!job) return notFound("Job not found.");
      return NextResponse.json(job);
    } catch (cause) {
      return serverError("GET /api/jobs/:id", cause, telemetry.log);
    }
  },
);
