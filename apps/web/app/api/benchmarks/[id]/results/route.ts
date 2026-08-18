import "server-only";

import {
  countEvaluationOutcomes,
  getBenchmarkCase,
  listEvaluationRunsByBenchmark,
} from "@rivet/core";
import { NextResponse } from "next/server";

import { notFound, serverError } from "@/lib/api/responses";
import { requireSession } from "@/lib/auth/guard";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `GET /api/benchmarks/:id/results` - one case's history across every suite.
 *
 * `caseVersionHash` travels on each run rather than being joined from the
 * registry, so a rebuilt case cannot retroactively relabel old results and a
 * caller can see exactly which of them predate the rebuild.
 */
export const GET = withRoute(
  "/api/benchmarks/:id/results",
  async (request: Request, telemetry: RouteTelemetry, context: RouteContext) => {
    const auth = await requireSession(request);
    if (auth) return auth;

    const { id } = await context.params;

    try {
      const benchmark = await getBenchmarkCase(id);
      if (!benchmark) return notFound("Benchmark case not found.");

      const runs = await listEvaluationRunsByBenchmark(benchmark.id);

      return NextResponse.json({
        benchmark: {
          id: benchmark.id,
          title: benchmark.title,
          category: benchmark.category,
          difficulty: benchmark.difficulty,
          versionHash: benchmark.versionHash,
          baseCommitSha: benchmark.baseCommitSha,
        },
        outcomes: countEvaluationOutcomes(runs),
        runs: runs.map((run) => ({
          ...run,
          gradedAt: run.gradedAt?.toISOString() ?? null,
          createdAt: run.createdAt.toISOString(),
        })),
      });
    } catch (cause) {
      return serverError("GET /api/benchmarks/:id/results", cause, telemetry.log);
    }
  },
);
