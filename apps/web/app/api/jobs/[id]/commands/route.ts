import "server-only";

import { serializeJobCommandSummary, type SerializedJobCommandSummary } from "@rivet/contracts";
import { getJob, listCommands } from "@rivet/core";
import { NextResponse } from "next/server";

import { badRequest, notFound, serverError } from "@/lib/api/responses";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface CommandsResponse {
  commands: SerializedJobCommandSummary[];
  cursor: number | null;
}

/** `?after=` must be a non-negative integer command id. */
function parseAfter(raw: string | null): number | null | undefined {
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

/** `GET /api/jobs/:id/commands?after=<id>` - command metadata, oldest first. */
export const GET = withRoute(
  "/api/jobs/:id/commands",
  async (request: Request, telemetry: RouteTelemetry, context: RouteContext) => {
    const { id } = await context.params;

    const after = parseAfter(new URL(request.url).searchParams.get("after"));
    if (after === undefined) {
      return badRequest("`after` must be a non-negative integer command id.");
    }

    try {
      const job = await getJob(id);
      if (!job) return notFound("Job not found.");

      const commands = await listCommands(id, after === null ? {} : { after });
      const body: CommandsResponse = {
        commands: commands.map(serializeJobCommandSummary),
        cursor: commands.at(-1)?.id ?? after,
      };
      return NextResponse.json(body);
    } catch (cause) {
      return serverError("GET /api/jobs/:id/commands", cause, telemetry.log);
    }
  },
);
