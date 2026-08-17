import type { EvaluationRunRecord } from "@rivet/core";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatFailureLabel,
  formatRuntimeSeconds,
  formatScore,
  RUN_RESULT_PRESENTATION,
} from "@/lib/evaluation-presentation";
import { formatAgentCost } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Every individual run, with its job as a link.
 *
 * That link is the architectural claim of the milestone: the evaluation
 * surface stores aggregates and grades and stores no second copy of anything
 * the job log already holds, so a number here always resolves to the full
 * timeline, plan, diff, validation report and review report that existed
 * before evaluation did. A run whose job creation itself failed has no id and
 * says so rather than rendering a dead link.
 */
export function EvaluationRunTable({ runs }: { runs: EvaluationRunRecord[] }) {
  return (
    <div className="border-border overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Case</TableHead>
            <TableHead>Arm</TableHead>
            <TableHead>Rep</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Score</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>Runtime</TableHead>
            <TableHead className="text-right">Job</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => {
            const presentation = RUN_RESULT_PRESENTATION[run.result];
            return (
              <TableRow key={run.id}>
                <TableCell className="font-mono text-xs">{run.benchmarkId}</TableCell>
                <TableCell className="text-xs">{run.arm}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{run.repetition}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={cn(presentation.className)}>
                    {presentation.label}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">{formatScore(run.score)}</TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {run.failureCategory === null && run.result === "passed"
                    ? "-"
                    : formatFailureLabel(run.failureCategory)}
                  {run.failureLabelSource === null ? "" : ` (${run.failureLabelSource})`}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                  {formatRuntimeSeconds(run.metrics.runtimeSeconds)}
                  {" · "}
                  {formatAgentCost(run.metrics.totalCostUsd)}
                </TableCell>
                <TableCell className="text-right text-xs">
                  {run.jobId ? (
                    <Link href={`/jobs/${run.jobId}`} className="font-mono hover:underline">
                      {run.jobId.slice(0, 8)}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">not created</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
