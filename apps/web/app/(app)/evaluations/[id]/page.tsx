import "server-only";

import type { BenchmarkCategory } from "@rivet/contracts";
import {
  getEvaluationSuite,
  listBenchmarkCases,
  listEvaluationRuns,
  summarizeEvaluationRuns,
  type EvaluationSuiteSummary,
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
import { Card, CardContent } from "@/components/ui/card";
import {
  formatCategory,
  formatScore,
  formatSuccessFraction,
  formatSuccessRate,
  formatRuntimeSeconds,
  suiteStatusClassName,
} from "@/lib/evaluation-presentation";
import { formatAgentCost, formatDateTime } from "@/lib/format";
import { requirePageSession } from "@/lib/auth/page-guard";
import { cn } from "@/lib/utils";

/** Reads Postgres on every request; `next build` has no database. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Evaluation suite" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EvaluationSuitePage({ params }: PageProps) {
  await requirePageSession();
  const { id } = await params;

  const suite = await getEvaluationSuite(id);
  if (!suite) notFound();

  const [runs, cases] = await Promise.all([listEvaluationRuns(suite.id), listBenchmarkCases()]);
  const categories: Record<string, BenchmarkCategory> = Object.fromEntries(
    cases.map((entry) => [entry.id, entry.category]),
  );
  const summary = summarizeEvaluationRuns(runs, { categories });
  const armSummaries = suite.arms.map((arm) => ({
    label: arm.label,
    summary: summarizeEvaluationRuns(
      runs.filter((run) => run.arm === arm.label),
      { categories },
    ),
  }));
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
        <p className="text-muted-foreground text-sm">
          <Link href="/evaluations" className="hover:underline">
            All suites
          </Link>
          {" / "}
          <span className="font-mono">{suite.id}</span>
        </p>
      </header>

      <section id="evaluation-summary" className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryMetric
            label="Graded success"
            value={formatSuccessRate(summary.overall.successRate)}
            hint={formatSuccessFraction(summary.overall)}
          />
          <SummaryMetric
            label="Typical runtime"
            value={formatRuntimeSeconds(summary.efficiency.medianRuntimeSeconds)}
            hint={`mean ${formatRuntimeSeconds(summary.efficiency.meanRuntimeSeconds)}`}
          />
          <SummaryMetric
            label="Mean model cost"
            value={formatAgentCost(summary.efficiency.meanCostUsd)}
            hint={`${formatAgentCost(summary.efficiency.totalCostUsd)} across ${String(summary.efficiency.runCount)} runs`}
          />
          <SummaryMetric
            label="Hidden tests"
            value={`${String(summary.quality.hiddenTestsPassed)}/${String(summary.quality.hiddenTestsTotal)}`}
            hint="assertions passed across graded runs"
          />
        </div>
        <p className="text-muted-foreground max-w-3xl text-xs leading-relaxed">
          {summary.overall.errored + summary.overall.ungraded} runs are excluded from the success
          rate: {summary.overall.errored} errored because Rivet or its environment failed and{" "}
          {summary.overall.ungraded} could not be graded. {summary.unlabeledFailures} failures still
          need a human label.
        </p>
      </section>

      <ArmComparison arms={armSummaries} />

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

function SummaryMetric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-muted/25 p-4 ring-1 ring-foreground/10">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="text-muted-foreground mt-1 text-xs">{hint}</p>
    </div>
  );
}

function ArmComparison({
  arms,
}: {
  arms: readonly { label: string; summary: EvaluationSuiteSummary }[];
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Arm comparison</h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          What each workflow bought, and what it cost. Differences are descriptive rather than a
          causal claim.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <div className="bg-muted/40 text-muted-foreground hidden grid-cols-[minmax(10rem,1.4fr)_repeat(4,minmax(7rem,1fr))] gap-4 px-4 py-2 text-xs md:grid">
          <span>Workflow</span>
          <span>Success</span>
          <span>Mean score</span>
          <span>Mean cost</span>
          <span>Mean runtime</span>
        </div>
        {arms.map(({ label, summary }) => (
          <div
            key={label}
            className="grid gap-3 border-t border-foreground/10 px-4 py-4 first:border-t-0 md:grid-cols-[minmax(10rem,1.4fr)_repeat(4,minmax(7rem,1fr))] md:items-baseline md:gap-4"
          >
            <p className="font-medium">{label}</p>
            <ArmMetric
              label="Success"
              value={`${formatSuccessRate(summary.overall.successRate)} ${formatSuccessFraction(summary.overall)}`}
            />
            <ArmMetric
              label="Mean score"
              value={formatScore(summary.byArm[0]?.meanScore ?? null)}
            />
            <ArmMetric label="Mean cost" value={formatAgentCost(summary.efficiency.meanCostUsd)} />
            <ArmMetric
              label="Mean runtime"
              value={formatRuntimeSeconds(summary.efficiency.meanRuntimeSeconds)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function ArmMetric({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-sm">
      <span className="text-muted-foreground mr-2 md:hidden">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </p>
  );
}
