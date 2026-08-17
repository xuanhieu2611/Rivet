import "server-only";

import { countEvaluationOutcomes, listEvaluationRuns, listEvaluationSuites } from "@rivet/core";
import type { Metadata } from "next";
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
  formatSuccessFraction,
  formatSuccessRate,
  suiteStatusClassName,
} from "@/lib/evaluation-presentation";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Reads Postgres on every request; `next build` has no database. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Evaluations" };

export default async function EvaluationsPage() {
  const suites = await listEvaluationSuites();

  // One run query per suite rather than a grouped aggregate: suites are created
  // by a person running a CLI, so there are tens of them, and keeping the read
  // path as the same store function the detail page uses means the list and the
  // detail can never disagree about what a suite scored.
  const rows = await Promise.all(
    suites.map(async (suite) => ({
      suite,
      counts: countEvaluationOutcomes(await listEvaluationRuns(suite.id)),
    })),
  );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Evaluations</h1>
        <p className="text-muted-foreground text-sm">
          {suites.length === 0
            ? "No suites yet."
            : `${String(suites.length)} suite${suites.length === 1 ? "" : "s"}, newest first.`}{" "}
          Success rate is computed over graded runs only; errored and ungraded runs are counted
          separately.
        </p>
      </div>

      {suites.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed px-6 py-16 text-center">
          <h2 className="text-base font-medium">Nothing measured yet</h2>
          <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">
            Suites are started from the command line - <code>pnpm eval:run</code>, after{" "}
            <code>pnpm eval:build</code>. Try <code>pnpm eval:run --dry-run</code> first: it prints
            the case x arm x repetition matrix without creating a job or spending anything.
          </p>
        </div>
      ) : (
        <div className="border-border overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Suite</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Matrix</TableHead>
                <TableHead>Success</TableHead>
                <TableHead className="text-right">Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ suite, counts }) => (
                <TableRow key={suite.id}>
                  <TableCell className="font-medium">
                    <Link href={`/evaluations/${suite.id}`} className="hover:underline">
                      {suite.label}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(suiteStatusClassName(suite.status))}>
                      {suite.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {suite.caseIds.length} cases x {suite.arms.length} arms x {suite.repetitions}
                    {" reps"}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className="font-medium">{formatSuccessRate(counts.successRate)}</span>{" "}
                    <span className="text-muted-foreground">{formatSuccessFraction(counts)}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-xs whitespace-nowrap">
                    {formatDateTime(suite.startedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
