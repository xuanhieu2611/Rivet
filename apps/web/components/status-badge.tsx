import type { JobStatus } from "@rivet/contracts";

import { Badge } from "@/components/ui/badge";
import { JOB_STATUS_PRESENTATION } from "@/lib/job-status";
import { cn } from "@/lib/utils";

/**
 * The single rendering of a job status in the app.
 *
 * Colours come from `JOB_STATUS_PRESENTATION`, which is typed as a total record
 * over `JobStatus`, so all fourteen statuses are covered by construction. The
 * hue says good, bad or working; the glyph and the label say which phase, and
 * the glyph is never alone - it always sits beside the word.
 */
export function StatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const { label, className: tone, icon: Icon, tone: toneName } = JOB_STATUS_PRESENTATION[status];

  return (
    <Badge
      variant="outline"
      data-status={status}
      data-tone={toneName}
      className={cn(tone, className)}
    >
      <Icon
        aria-hidden
        className={cn(toneName === "progress" && "animate-pulse motion-reduce:animate-none")}
      />
      {label}
    </Badge>
  );
}
