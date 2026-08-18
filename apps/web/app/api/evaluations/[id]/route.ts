import "server-only";

import type { BenchmarkCategory } from "@rivet/contracts";
import {
  getEvaluationSuite,
  listBenchmarkCases,
  listEvaluationRuns,
  summarizeEvaluationRuns,
  type EvaluationRunRecord,
} from "@rivet/core";
import { NextResponse } from "next/server";

import { notFound, serverError } from "@/lib/api/responses";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** A run as JSON: identical to the stored row with dates as ISO strings. */
function serializeRun(run: EvaluationRunRecord) {
  return {
    ...run,
    gradedAt: run.gradedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

/**
 * `GET /api/evaluations/:id` - one suite, its runs and its aggregates.
 *
 * Read-only by design. `POST /api/evaluations` is deliberately absent: the
 * runner is a CLI in this milestone, and an unauthenticated endpoint that
 * starts a paid multi-hour matrix is the wrong thing to add to a single-owner
 * app (see SECURITY.md).
 */
export const GET = withRoute(
  "/api/evaluations/:id",
  async (_request: Request, telemetry: RouteTelemetry, context: RouteContext) => {
    const { id } = await context.params;

    try {
      const suite = await getEvaluationSuite(id);
      if (!suite) return notFound("Evaluation suite not found.");

      const [runs, cases] = await Promise.all([listEvaluationRuns(suite.id), listBenchmarkCases()]);
      const categories: Record<string, BenchmarkCategory> = Object.fromEntries(
        cases.map((entry) => [entry.id, entry.category]),
      );

      return NextResponse.json({
        suite: {
          ...suite,
          startedAt: suite.startedAt.toISOString(),
          completedAt: suite.completedAt?.toISOString() ?? null,
          createdAt: suite.createdAt.toISOString(),
        },
        summary: summarizeEvaluationRuns(runs, { categories }),
        runs: runs.map(serializeRun),
      });
    } catch (cause) {
      return serverError("GET /api/evaluations/:id", cause, telemetry.log);
    }
  },
);
