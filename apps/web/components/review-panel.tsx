import type { JobArtifact, JobDetail, ReviewDecision, ReviewIssue } from "@rivet/contracts";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import {
  formatReviewConfidence,
  groupReviewIssues,
  readReviewReport,
  type ReviewIssueGroup,
} from "@/lib/review-report";
import { cn } from "@/lib/utils";

const REVIEW_DECISION_PRESENTATION: Record<ReviewDecision, { label: string; className: string }> = {
  approve: {
    label: "Approved",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  revise: {
    label: "Revision requested",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
};

type ReviewPanelJob = Pick<
  JobDetail,
  "reviewMode" | "maxReviewLoops" | "reviewLoops" | "reviewDecision" | "reviewBlockingCount"
>;

/** Server-rendered structured verdict from the latest independent review. */
export function ReviewPanel({
  artifact,
  job,
}: {
  artifact: JobArtifact | null;
  job: ReviewPanelJob;
}) {
  const report = readReviewReport(artifact);
  const decision = report?.decision ?? job.reviewDecision;

  return (
    <Card id="review" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>Independent review</CardTitle>
        <CardDescription>
          A fresh read-only reviewer inspected the patch, changed tests and deterministic validation
          before the run could finalize.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {report && artifact ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-2">
                <DecisionBadge decision={decision ?? report.decision} />
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {report.summary}
                </p>
              </div>
              <ReviewFacts
                confidence={report.confidence}
                reviewLoops={job.reviewLoops}
                maxReviewLoops={job.maxReviewLoops}
              />
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <FindingList
                title="Blocking findings"
                issues={report.blockingIssues}
                tone="blocking"
              />
              <FindingList
                title="Non-blocking findings"
                issues={report.nonBlockingIssues}
                tone="non-blocking"
              />
            </div>

            <p className="text-muted-foreground text-xs">
              Artifact #{String(artifact.id)} · recorded {formatDateTime(artifact.createdAt)}
            </p>
          </div>
        ) : artifact ? (
          <p className="text-muted-foreground text-sm">
            Artifact #{String(artifact.id)} is not a readable structured review report. The raw
            record is still listed under Artifacts.
          </p>
        ) : (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              {job.reviewMode === "none"
                ? "Independent review was skipped for this job by request."
                : "No review report has been recorded yet. It appears after deterministic validation."}
            </p>
            <div className="flex flex-wrap items-center gap-4">
              {decision ? <DecisionBadge decision={decision} /> : null}
              <ReviewFacts
                confidence={null}
                reviewLoops={job.reviewLoops}
                maxReviewLoops={job.maxReviewLoops}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DecisionBadge({ decision }: { decision: ReviewDecision }) {
  const presentation = REVIEW_DECISION_PRESENTATION[decision];

  return (
    <Badge variant="outline" className={presentation.className}>
      {presentation.label}
    </Badge>
  );
}

function ReviewFacts({
  confidence,
  reviewLoops,
  maxReviewLoops,
}: {
  confidence: number | null;
  reviewLoops: number;
  maxReviewLoops: number;
}) {
  return (
    <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-right text-xs">
      <div>
        <dt className="text-muted-foreground">Confidence</dt>
        <dd className="mt-0.5 font-medium tabular-nums">
          {confidence === null ? "not yet" : formatReviewConfidence(confidence)}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Review loops</dt>
        <dd className="mt-0.5 font-medium tabular-nums">
          {String(reviewLoops)} / {String(maxReviewLoops)}
        </dd>
      </div>
    </dl>
  );
}

function FindingList({
  title,
  issues,
  tone,
}: {
  title: string;
  issues: readonly ReviewIssue[];
  tone: "blocking" | "non-blocking";
}) {
  const groups = groupReviewIssues(issues);

  return (
    <section className="min-w-0 space-y-3" data-finding-list={tone}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-muted-foreground text-xs">
          {String(issues.length)} {issues.length === 1 ? "finding" : "findings"}
        </span>
      </div>
      {groups.length > 0 ? (
        <div className="space-y-3">
          {groups.map((group) => (
            <FindingCategory key={group.category} group={group} tone={tone} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
          None
        </p>
      )}
    </section>
  );
}

function FindingCategory({
  group,
  tone,
}: {
  group: ReviewIssueGroup;
  tone: "blocking" | "non-blocking";
}) {
  return (
    <section className="space-y-2" data-review-category={group.category}>
      <h4
        className={cn(
          "text-xs font-medium tracking-wide uppercase",
          tone === "blocking" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
        )}
      >
        {group.label}
      </h4>
      <ol className="space-y-2">
        {group.issues.map((issue, index) => (
          <Finding key={`${issue.category}-${index}`} issue={issue} />
        ))}
      </ol>
    </section>
  );
}

function Finding({ issue }: { issue: ReviewIssue }) {
  return (
    <li className="border-border/60 rounded-md border bg-muted/20 px-3 py-2.5">
      <h5 className="text-sm font-medium leading-snug">{issue.title}</h5>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed whitespace-pre-wrap break-words">
        {issue.detail}
      </p>
      {issue.paths.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Related paths">
          {issue.paths.map((path) => (
            <li key={path}>
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] break-all">
                {path}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
