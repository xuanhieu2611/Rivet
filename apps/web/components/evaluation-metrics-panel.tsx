import type { EvaluationEfficiencySummary, EvaluationQualitySummary } from "@rivet/core";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRuntimeSeconds } from "@/lib/evaluation-presentation";
import { formatAgentCost, formatTokenCount } from "@/lib/format";

/** One labelled number. The whole §24.4 surface is a grid of these. */
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
      {hint ? <p className="text-muted-foreground text-[11px]">{hint}</p> : null}
    </div>
  );
}

/**
 * The §24.4 efficiency and quality families for one suite.
 *
 * Every figure is a sum or an average of the metric snapshots written at grade
 * time, so it stays consistent with the numbers on each job page even after a
 * later milestone changes how a metric is computed. Nothing here re-derives a
 * value from a job row.
 */
export function EvaluationMetricsPanel({
  efficiency,
  quality,
}: {
  efficiency: EvaluationEfficiencySummary;
  quality: EvaluationQualitySummary;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Efficiency</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4">
            <Metric
              label="Median runtime"
              value={formatRuntimeSeconds(efficiency.medianRuntimeSeconds)}
              hint={`mean ${formatRuntimeSeconds(efficiency.meanRuntimeSeconds)}`}
            />
            <Metric
              label="Total cost"
              value={formatAgentCost(efficiency.totalCostUsd)}
              hint={`mean ${formatAgentCost(efficiency.meanCostUsd)} per run`}
            />
            <Metric
              label="Model calls"
              value={formatTokenCount(efficiency.totalModelCalls)}
              hint={`${formatTokenCount(efficiency.totalToolCalls)} tool calls, ${formatTokenCount(efficiency.totalTurns)} turns`}
            />
            <Metric
              label="Tokens"
              value={formatTokenCount(efficiency.totalInputTokens + efficiency.totalOutputTokens)}
              hint={`${formatTokenCount(efficiency.totalInputTokens)} in, ${formatTokenCount(efficiency.totalOutputTokens)} out`}
            />
            <Metric label="Runs" value={String(efficiency.runCount)} />
            <Metric label="Job attempts" value={String(efficiency.totalAttempts)} />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Quality</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4">
            <Metric
              label="Regressed runs"
              value={String(quality.regressedRuns)}
              hint={`${String(quality.newFailureTotal)} new test failures, ${String(quality.fixedFailureTotal)} fixed`}
            />
            <Metric
              label="Hidden tests"
              value={`${String(quality.hiddenTestsPassed)}/${String(quality.hiddenTestsTotal)}`}
              hint="assertions passed across graded runs"
            />
            <Metric
              label="Mean files changed"
              value={formatMean(quality.meanFilesChanged)}
              hint={`+${formatMean(quality.meanInsertions)} / -${formatMean(quality.meanDeletions)} lines`}
            />
            <Metric
              label="Review decisions"
              value={`${String(quality.reviewApproved)} approved, ${String(quality.reviewRevised)} revised`}
              hint={`${String(quality.reviewAbsent)} runs had no review; mean ${formatMean(quality.meanReviewLoops)} loops`}
            />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

/** A null mean means no run produced the source artifact, not that it was zero. */
function formatMean(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}
