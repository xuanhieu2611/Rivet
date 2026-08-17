import type { EvaluationGroupSummary } from "@rivet/core";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatScore,
  formatSuccessFraction,
  formatSuccessRate,
} from "@/lib/evaluation-presentation";

/**
 * Success by one grouping - arm, case or category.
 *
 * The three groupings render through one component because they are the same
 * table with a different first column, and because the excluded-run counts
 * have to be shown identically in all three. A grouping that quietly rounded
 * `errored` runs into its denominator in only one place would be the easiest
 * possible way for this page to lie.
 */
export function EvaluationGroupTable({
  heading,
  keyHeading,
  groups,
  formatKey = (key) => key,
  monospace = false,
}: {
  heading: string;
  keyHeading: string;
  groups: EvaluationGroupSummary[];
  formatKey?: (key: string) => string;
  monospace?: boolean;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{heading}</h3>
      <div className="border-border overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{keyHeading}</TableHead>
              <TableHead>Success</TableHead>
              <TableHead>Graded</TableHead>
              <TableHead>Not graded</TableHead>
              <TableHead className="text-right">Mean score</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <TableRow key={group.key}>
                <TableCell className={monospace ? "font-mono text-xs" : "text-xs font-medium"}>
                  {formatKey(group.key)}
                </TableCell>
                <TableCell className="text-xs font-medium">
                  {formatSuccessRate(group.counts.successRate)}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {formatSuccessFraction(group.counts)}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {group.counts.errored} errored, {group.counts.ungraded} ungraded
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-xs">
                  {formatScore(group.meanScore)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
