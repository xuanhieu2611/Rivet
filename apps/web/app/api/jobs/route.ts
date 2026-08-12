import "server-only";

import { createJobSchema } from "@rivet/contracts";
import { NextResponse } from "next/server";

import { badRequest, readJsonBody, serverError, validationFailed } from "@/lib/api/responses";
import { createJob, listJobs, resolveListLimit } from "@/lib/services/job-service";

/**
 * Never prerender: these handlers talk to Postgres, and `next build` must not
 * need a live database. Also pins the Node.js runtime implicitly - the `pg` pool
 * cannot run on edge, so no `runtime = "edge"` here or in any sibling file.
 */
export const dynamic = "force-dynamic";

/** `GET /api/jobs` - newest first, capped by `?limit=`. */
export async function GET(request: Request) {
  try {
    const limit = resolveListLimit(new URL(request.url).searchParams.get("limit"));
    const jobs = await listJobs({ limit });
    return NextResponse.json({ jobs, limit });
  } catch (cause) {
    return serverError("GET /api/jobs", cause);
  }
}

/** `POST /api/jobs` - validate, persist, return 201 with the created job. */
export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) {
    return badRequest("Request body must be valid JSON.");
  }

  const parsed = createJobSchema.safeParse(body.value);
  if (!parsed.success) {
    return validationFailed(parsed.error);
  }

  try {
    const job = await createJob(parsed.data);
    return NextResponse.json(job, {
      status: 201,
      headers: { Location: `/api/jobs/${job.id}` },
    });
  } catch (cause) {
    return serverError("POST /api/jobs", cause);
  }
}
