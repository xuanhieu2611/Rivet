import "server-only";

import { serializeJobCommand } from "@rivet/contracts";
import { getCommand, getJob } from "@rivet/core";
import { NextResponse } from "next/server";

import { badRequest, notFound, serverError } from "@/lib/api/responses";
import { requireSession } from "@/lib/auth/guard";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; commandId: string }>;
}

/** Command ids are positive, safe integers because they come from bigserial. */
function parseCommandId(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** `GET /api/jobs/:id/commands/:commandId` - one command with its transcript. */
export const GET = withRoute(
  "/api/jobs/:id/commands/:commandId",
  async (request: Request, telemetry: RouteTelemetry, context: RouteContext) => {
    const auth = await requireSession(request);
    if (auth) return auth;

    const { id, commandId: rawCommandId } = await context.params;
    const commandId = parseCommandId(rawCommandId);
    if (commandId === undefined) {
      return badRequest("`commandId` must be a positive integer.");
    }

    try {
      const job = await getJob(id);
      if (!job) return notFound("Job not found.");

      const command = await getCommand(id, commandId);
      if (!command) return notFound("Command not found.");

      return NextResponse.json(serializeJobCommand(command));
    } catch (cause) {
      return serverError("GET /api/jobs/:id/commands/:commandId", cause, telemetry.log);
    }
  },
);
