import "server-only";

import { jobStatusSchema } from "@rivet/contracts";
import { getJob, updateJobStatus } from "@rivet/core";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  badRequest,
  notFound,
  readJsonBody,
  serverError,
  validationFailed,
} from "@/lib/api/responses";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET /api/jobs/:id` - 404 when the id is unknown or not a uuid. */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const job = await getJob(id);
    if (!job) return notFound("Job not found.");
    return NextResponse.json(job);
  } catch (cause) {
    return serverError("GET /api/jobs/:id", cause);
  }
}

const patchJobSchema = z.object({ status: jobStatusSchema });

/**
 * `PATCH /api/jobs/:id` - development-only status advance.
 *
 * TODO(M1): delete when the worker drives transitions. Nothing executes jobs in
 * Milestone 0, so every job would read `queued` forever; this endpoint exists to
 * prove the status pipeline end to end (enum -> contract -> badge -> refetch)
 * without faking a transition anywhere else in the stack.
 *
 * Hard-guarded: in production the route is indistinguishable from a typo.
 */
export async function PATCH(request: Request, context: RouteContext) {
  if (process.env.NODE_ENV === "production") {
    return notFound();
  }

  const { id } = await context.params;

  const body = await readJsonBody(request);
  if (!body) {
    return badRequest("Request body must be valid JSON.");
  }

  const parsed = patchJobSchema.safeParse(body.value);
  if (!parsed.success) {
    return validationFailed(parsed.error);
  }

  try {
    const job = await updateJobStatus(id, parsed.data.status);
    if (!job) return notFound("Job not found.");
    return NextResponse.json(job);
  } catch (cause) {
    return serverError("PATCH /api/jobs/:id", cause);
  }
}
