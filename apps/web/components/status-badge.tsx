import type { JobStatus } from "@rivet/contracts";

import { Badge } from "@/components/ui/badge";
import { JOB_STATUS_PRESENTATION } from "@/lib/job-status";
import { cn } from "@/lib/utils";

/**
 * The single rendering of a job status in the app.
 *
 * Colours come from `JOB_STATUS_PRESENTATION`, which is typed as a total record
 * over `JobStatus`, so all fourteen statuses are covered by construction.
 */
export function StatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const { label, className: tone } = JOB_STATUS_PRESENTATION[status];

  return (
    <Badge variant="outline" data-status={status} className={cn(tone, className)}>
      {label}
    </Badge>
  );
}
