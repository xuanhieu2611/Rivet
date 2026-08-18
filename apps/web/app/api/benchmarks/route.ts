import "server-only";

import { listBenchmarkCases } from "@rivet/core";
import { NextResponse } from "next/server";

import { serverError } from "@/lib/api/responses";
import { requireSession } from "@/lib/auth/guard";
import { withRoute, type RouteTelemetry } from "@/lib/api/route-telemetry";

export const dynamic = "force-dynamic";

/**
 * `GET /api/benchmarks` - the registered benchmark cases.
 *
 * `benchmark_cases` is a cache of what the builder last saw on disk, not the
 * truth: the files under the benchmark root own that. `versionHash` is
 * returned so a caller can tell whether a stored result was produced by the
 * case as it exists now.
 */
export const GET = withRoute(
  "/api/benchmarks",
  async (request: Request, telemetry: RouteTelemetry) => {
    const auth = await requireSession(request);
    if (auth) return auth;

    try {
      const cases = await listBenchmarkCases();
      return NextResponse.json({
        benchmarks: cases.map((entry) => ({
          id: entry.id,
          title: entry.title,
          category: entry.category,
          difficulty: entry.difficulty,
          versionHash: entry.versionHash,
          baseCommitSha: entry.baseCommitSha,
          spec: entry.spec,
          createdAt: entry.createdAt.toISOString(),
          updatedAt: entry.updatedAt.toISOString(),
        })),
      });
    } catch (cause) {
      return serverError("GET /api/benchmarks", cause, telemetry.log);
    }
  },
);
