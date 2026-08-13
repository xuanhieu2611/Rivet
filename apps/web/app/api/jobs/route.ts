import "server-only";

import { createJobSchema } from "@rivet/contracts";
import { createJob, listJobs, requestJobRun, resolveListLimit } from "@rivet/core";
import { getJobQueue } from "@rivet/queue";
import { NextResponse } from "next/server";

import { badRequest, readJsonBody, serverError, validationFailed } from "@/lib/api/responses";

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

/** `POST /api/jobs` - validate, persist, enqueue, return 201 with the created job. */
export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body) {
    return badRequest("Request body must be valid JSON.");
  }

  const parsed = createJobSchema.safeParse(body.value);
  if (!parsed.success) {
    return validationFailed(parsed.error);
  }

  let job;
  try {
    job = await createJob(parsed.data);
  } catch (cause) {
    return serverError("POST /api/jobs", cause);
  }

  // Deliberately outside the try above, and deliberately not able to fail the
  // request. The row is committed; the job exists. Returning 500 because Redis
  // is unreachable would be a lie the client could not act on, and it would
  // tempt a retry that creates a second job. A `queued` row with no message is
  // exactly what the sweeper reconciles, within a minute.
  const outcome = await requestJobRun(job.id, getJobQueue());
  if (outcome.error) {
    console.error(`POST /api/jobs: enqueue failed for ${job.id}`, outcome.error);
  }

  return NextResponse.json(job, {
    status: 201,
    headers: { Location: `/api/jobs/${job.id}` },
  });
}
