import "server-only";

import { requestJobCancellation } from "@rivet/core";
import { getJobQueue } from "@rivet/queue";
import { NextResponse } from "next/server";

import { conflict, notFound, serverError } from "@/lib/api/responses";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/jobs/:id/cancel`
 *
 * Three answers, and the difference between them is the whole endpoint:
 *
 * - `200` - the job had not started and is now `cancelled`. Done.
 * - `202` - a worker has it. The request is recorded and the job stops within a
 *   heartbeat interval. Accepted, not completed, because this process cannot
 *   make it true; only the worker holding the lease can.
 * - `409` - it already finished. The body carries the status that made the
 *   request moot.
 *
 * Idempotent: cancelling a job that is already cancelling is another `202`.
 */
export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const result = await requestJobCancellation(id, getJobQueue());

    switch (result.outcome) {
      case "not_found":
        return notFound("Job not found.");

      case "cancelled":
        if (result.queueError) {
          // The job is cancelled either way - a leftover message cannot claim
          // it. Worth a log, not worth a different status code.
          console.error(
            `POST /api/jobs/${id}/cancel: could not drop the queue message`,
            result.queueError,
          );
        }
        return NextResponse.json(result.job);

      case "cancel_requested":
        return NextResponse.json(result.job, { status: 202 });

      case "already_terminal":
        return conflict(`This job already finished as ${result.job.status}.`, {
          status: result.job.status,
        });
    }
  } catch (cause) {
    return serverError("POST /api/jobs/:id/cancel", cause);
  }
}
