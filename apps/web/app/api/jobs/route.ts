import "server-only";

import { createJobSchema } from "@rivet/contracts";
import {
  ActiveJobLimitError,
  createJob,
  listJobs,
  requestJobRun,
  resolveListLimit,
} from "@rivet/core";
import { getJobQueue, getRateLimiter, RateLimitUnavailableError } from "@rivet/queue";
import { NextResponse } from "next/server";

import { badRequest, readJsonBody, serverError, validationFailed } from "@/lib/api/responses";
import { csrfFailure } from "@/lib/auth/csrf";
import { authenticatedPrincipal, requireSession } from "@/lib/auth/guard";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";
import { currentTraceContext } from "@/lib/telemetry/telemetry";
import { resolveWebRateLimitConfig } from "@/lib/rate-limit/config";
import { rateLimitKey } from "@/lib/rate-limit/request";
import {
  activeJobCapExceeded,
  rateLimitExceeded,
  rateLimitUnavailable,
} from "@/lib/rate-limit/response";

/**
 * Never prerender: these handlers talk to Postgres, and `next build` must not
 * need a live database. Also pins the Node.js runtime implicitly - the `pg` pool
 * cannot run on edge, so no `runtime = "edge"` here or in any sibling file.
 */
export const dynamic = "force-dynamic";

/** `GET /api/jobs` - newest first, capped by `?limit=`. */
export const GET = withRoute("/api/jobs", async (request: Request, telemetry: RouteTelemetry) => {
  const auth = await requireSession(request);
  if (auth) return auth;

  try {
    const limit = resolveListLimit(new URL(request.url).searchParams.get("limit"));
    const jobs = await listJobs({ limit });
    return NextResponse.json({ jobs, limit });
  } catch (cause) {
    return serverError("GET /api/jobs", cause, telemetry.log);
  }
});

/** `POST /api/jobs` - validate, persist, enqueue, return 201 with the created job. */
export const POST = withRoute("/api/jobs", async (request: Request, telemetry: RouteTelemetry) => {
  const auth = await requireSession(request);
  if (auth) return auth;
  const csrf = csrfFailure(request);
  if (csrf) return csrf;

  const body = await readJsonBody(request);
  if (!body) {
    return badRequest("Request body must be valid JSON.");
  }

  const parsed = createJobSchema.safeParse(body.value);
  if (!parsed.success) {
    return validationFailed(parsed.error);
  }

  const rateLimits = resolveWebRateLimitConfig();
  const principal = await authenticatedPrincipal(request);
  if (!principal) {
    return NextResponse.json(
      { error: "Authentication required. Sign in with GitHub to create a job." },
      { status: 401 },
    );
  }

  try {
    const result = await getRateLimiter().consume(
      rateLimitKey("job-creation", principal),
      rateLimits.jobCreationLimit,
      rateLimits.jobCreationWindowMs,
    );
    if (!result.allowed) {
      return rateLimitExceeded("job creations", rateLimits.jobCreationLimit, result);
    }
  } catch (cause) {
    if (!(cause instanceof RateLimitUnavailableError)) throw cause;
    return rateLimitUnavailable();
  }

  let job;
  try {
    // The creating request's own span, stored so each attempt of the run can
    // *link* back to it. Deliberately not part of `createJobSchema`: a client
    // must not get to choose which trace its job is attributed to, and Zod has
    // already stripped the key if one was sent. `undefined` when telemetry is
    // off, which is the ordinary case and leaves the column null.
    const traceContext = currentTraceContext();
    job = await createJob(
      {
        ...parsed.data,
        ...(traceContext ? { traceContext } : {}),
      },
      undefined,
      { activeJobLimit: rateLimits.activeJobCap },
    );
  } catch (cause) {
    if (cause instanceof ActiveJobLimitError) {
      return activeJobCapExceeded(cause.limit, cause.activeCount);
    }
    return serverError("POST /api/jobs", cause, telemetry.log);
  }

  // Deliberately outside the try above, and deliberately not able to fail the
  // request. The row is committed; the job exists. Returning 500 because Redis
  // is unreachable would be a lie the client could not act on, and it would
  // tempt a retry that creates a second job. A `queued` row with no message is
  // exactly what the sweeper reconciles, within a minute.
  const outcome = await requestJobRun(job.id, job.dispatchGeneration, getJobQueue());
  if (outcome.error) {
    telemetry.log.error({ err: outcome.error, jobId: job.id }, "enqueue failed");
  }

  return NextResponse.json(job, {
    status: 201,
    headers: { Location: `/api/jobs/${job.id}` },
  });
});
