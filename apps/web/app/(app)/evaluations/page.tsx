import "server-only";

import { countEvaluationOutcomes, listEvaluationRuns, listEvaluationSuites } from "@rivet/core";
import { SquareActivity } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { InlineCode } from "@/components/ui/inline-code";
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
import { requirePageSession } from "@/lib/auth/page-guard";
import { cn } from "@/lib/utils";

/** Reads Postgres on every request; `next build` has no database. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Evaluations" };

export default async function EvaluationsPage() {
  await requirePageSession();
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
        <EmptyState icon={SquareActivity} title="Nothing measured yet">
          Suites are started from the command line - <InlineCode>pnpm eval:run</InlineCode>, after{" "}
          <InlineCode>pnpm eval:build</InlineCode>. Try{" "}
          <InlineCode>pnpm eval:run --dry-run</InlineCode> first: it prints the case x arm x
          repetition matrix without creating a job or spending anything.
        </EmptyState>
      ) : (
        <>
          {/* Five columns on a phone is worse than four; same fallback as /jobs. */}
          <div className="border-border hidden overflow-hidden rounded-xl border sm:block">
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
                    <TableCell className="text-muted-foreground text-sm">
                      {suite.caseIds.length} cases x {suite.arms.length} arms x {suite.repetitions}
                      {" reps"}
                    </TableCell>
                    <TableCell className="text-sm">
                      <span className="font-medium">{formatSuccessRate(counts.successRate)}</span>{" "}
                      <span className="text-muted-foreground">{formatSuccessFraction(counts)}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs whitespace-nowrap">
                      <RelativeTime value={suite.startedAt} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="border-border divide-border/60 divide-y overflow-hidden rounded-xl border sm:hidden">
            {rows.map(({ suite, counts }) => (
              <li key={suite.id}>
                <Link
                  href={`/evaluations/${suite.id}`}
                  className="hover:bg-muted/40 block space-y-2 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm leading-snug font-medium">{suite.label}</p>
                    <Badge
                      variant="outline"
                      className={cn("shrink-0", suiteStatusClassName(suite.status))}
                    >
                      {suite.status}
                    </Badge>
                  </div>
                  <p className="text-sm">
                    <span className="font-medium">{formatSuccessRate(counts.successRate)}</span>{" "}
                    <span className="text-muted-foreground">{formatSuccessFraction(counts)}</span>
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {suite.caseIds.length} cases x {suite.arms.length} arms x {suite.repetitions}
                    {" reps · "}
                    <RelativeTime value={suite.startedAt} />
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
