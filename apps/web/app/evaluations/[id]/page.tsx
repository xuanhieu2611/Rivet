import "server-only";

import type { BenchmarkCategory } from "@rivet/contracts";
import {
  getEvaluationSuite,
  listBenchmarkCases,
  listEvaluationRuns,
  summarizeEvaluationRuns,
} from "@rivet/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EvaluationFailureHistogram } from "@/components/evaluation-failure-histogram";
import { EvaluationGroupTable } from "@/components/evaluation-group-table";
import { EvaluationMatrixTable } from "@/components/evaluation-matrix-table";
import { EvaluationMetricsPanel } from "@/components/evaluation-metrics-panel";
import { EvaluationRunTable } from "@/components/evaluation-run-table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatCategory,
  formatSuccessFraction,
  formatSuccessRate,
  suiteStatusClassName,
} from "@/lib/evaluation-presentation";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Reads Postgres on every request; `next build` has no database. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Evaluation suite" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EvaluationSuitePage({ params }: PageProps) {
  const { id } = await params;

  const suite = await getEvaluationSuite(id);
  if (!suite) notFound();

  const [runs, cases] = await Promise.all([listEvaluationRuns(suite.id), listBenchmarkCases()]);
  const categories: Record<string, BenchmarkCategory> = Object.fromEntries(
    cases.map((entry) => [entry.id, entry.category]),
  );
  const summary = summarizeEvaluationRuns(runs, { categories });
  const expected = suite.caseIds.length * suite.arms.length * suite.repetitions;

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{suite.label}</h1>
          <Badge variant="outline" className={cn(suiteStatusClassName(suite.status))}>
            {suite.status}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          {suite.caseIds.length} cases x {suite.arms.length} arms x {suite.repetitions} repetitions
          = {expected} expected runs, {runs.length} recorded. Started{" "}
          {formatDateTime(suite.startedAt)}, finished {formatDateTime(suite.completedAt)}.
        </p>
        <p className="text-muted-foreground text-xs">
          <Link href="/evaluations" className="hover:underline">
            All suites
          </Link>
          {" · "}
          <span className="font-mono">{suite.id}</span>
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Success rate</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {formatSuccessRate(summary.overall.successRate)}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {formatSuccessFraction(summary.overall)} graded runs
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Excluded from the rate</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {summary.overall.errored + summary.overall.ungraded}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {summary.overall.errored} errored (Rivet or its environment),{" "}
              {summary.overall.ungraded} ungraded (grading itself broke)
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Unlabelled failures</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{summary.unlabeledFailures}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Not machine-decidable; <code>pnpm eval:label</code> assigns these by hand.
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Case x arm</h2>
        <EvaluationMatrixTable
          arms={summary.arms}
          benchmarkIds={summary.benchmarkIds}
          matrix={summary.matrix}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">Success by group</h2>
        <EvaluationGroupTable heading="By arm" keyHeading="Arm" groups={summary.byArm} />
        <EvaluationGroupTable
          heading="By case"
          keyHeading="Case"
          groups={summary.byCase}
          monospace
        />
        <EvaluationGroupTable
          heading="By category"
          keyHeading="Category"
          groups={summary.byCategory}
          formatKey={formatCategory}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Metrics</h2>
        <EvaluationMetricsPanel efficiency={summary.efficiency} quality={summary.quality} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Failures</h2>
        <Card>
          <CardContent className="pt-6">
            <EvaluationFailureHistogram buckets={summary.failures} />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Runs</h2>
        {runs.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No runs recorded yet. A suite writes a row once each job has finished and been graded.
          </p>
        ) : (
          <EvaluationRunTable runs={runs} />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">Arms</h2>
        <ul className="text-muted-foreground space-y-1 text-xs">
          {suite.arms.map((arm) => (
            <li key={arm.label}>
              <span className="text-foreground font-medium">{arm.label}</span>{" "}
              <span className="font-mono">{JSON.stringify(arm.jobPatch)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
