import type { JobDetail, ValidationOutcome } from "@rivet/contracts";

import { ValidationOutcomeBadge } from "@/components/validation-outcome-badge";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/link";
import { RelativeTime } from "@/components/relative-time";
import { type DiffStats, formatDiffStats } from "@/lib/diff-stats";
import { formatElapsed } from "@/lib/format";
import { describeJobOutcome, type JobOutcomeTone } from "@/lib/job-outcome";
import { cn } from "@/lib/utils";

const TONE_CLASSNAME: Record<JobOutcomeTone, string> = {
  positive: "border-emerald-500/30 bg-emerald-500/[0.07]",
  negative: "border-destructive/30 bg-destructive/[0.06]",
  neutral: "border-border bg-muted/40",
};

const TONE_HEADLINE: Record<JobOutcomeTone, string> = {
  positive: "text-emerald-800 dark:text-emerald-200",
  negative: "text-destructive",
  neutral: "text-foreground",
};

interface JobResultHeaderProps {
  job: JobDetail;
  diffStats: DiffStats | null;
  validationOutcome: ValidationOutcome | null;
}

/**
 * What the job came to, above everything else on the page.
 *
 * The point of a run is a pull request and a diff, and both used to be several
 * scrolls down - the link a row inside a sidebar card, the stat inside the sixth
 * card. Rendered only for a terminal job: a queued or running one has no result
 * to lead with, and the phase stepper is the honest answer at that point.
 */
export function JobResultHeader({ job, diffStats, validationOutcome }: JobResultHeaderProps) {
  const outcome = describeJobOutcome(job);

  return (
    <section
      aria-label="Job result"
      data-outcome-tone={outcome.tone}
      className={cn("space-y-4 rounded-xl border px-5 py-4", TONE_CLASSNAME[outcome.tone])}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 className={cn("text-base font-semibold", TONE_HEADLINE[outcome.tone])}>
            {outcome.headline}
          </h2>
          <p className="text-muted-foreground max-w-prose text-sm">{outcome.detail}</p>
        </div>

        {job.pullRequestUrl ? (
          <Button asChild size="lg">
            <a href={job.pullRequestUrl} target="_blank" rel="noreferrer noopener">
              View pull request
              {job.pullRequestNumber === null ? null : ` #${String(job.pullRequestNumber)}`}
            </a>
          </Button>
        ) : null}
      </div>

      <dl className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        {validationOutcome ? (
          <Fact label="Validation">
            <ValidationOutcomeBadge outcome={validationOutcome} />
          </Fact>
        ) : null}

        {diffStats ? (
          <Fact label="Changes">
            <span className="font-mono tabular-nums">{formatDiffStats(diffStats)}</span>
          </Fact>
        ) : null}

        <Fact label="Duration">
          <span className="font-mono tabular-nums">
            {formatElapsed(job.startedAt, job.completedAt)}
          </span>
        </Fact>

        {job.completedAt ? (
          <Fact label="Finished">
            <RelativeTime value={job.completedAt} />
          </Fact>
        ) : null}

        {job.issueUrl || job.issueNumber !== null ? (
          <Fact label="Issue">
            {job.issueUrl ? (
              <ExternalLink href={job.issueUrl}>
                {job.issueNumber === null ? "View issue" : `#${String(job.issueNumber)}`}
              </ExternalLink>
            ) : (
              `#${String(job.issueNumber)}`
            )}
          </Fact>
        ) : null}
      </dl>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
