import "server-only";

import { isTerminal, serializeJobCommandSummary, serializeJobEvent } from "@rivet/contracts";
import { getArtifact, getJob, listArtifacts, listCommands, listEvents } from "@rivet/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CancelJobButton } from "@/components/cancel-job-button";
import { JobLiveProvider } from "@/components/job-live/job-live-provider";
import { LiveConnectionIndicator, LiveStatusBadge } from "@/components/job-live/live-status-badge";
import { LiveAgentUsage } from "@/components/job-live/live-agent-usage";
import { LiveCommandLog } from "@/components/job-live/live-command-log";
import { LiveExecutionTimeline } from "@/components/job-live/live-execution-timeline";
import { ImplementationPlanPanel } from "@/components/implementation-plan-panel";
import { JobArtifactsPanel } from "@/components/job-artifacts-panel";
import { ReviewPanel } from "@/components/review-panel";
import { ValidationPanel } from "@/components/validation-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatDuration, formatElapsed, formatUsd } from "@/lib/format";
import { FAILURE_CATEGORY_LABELS } from "@/lib/job-status";

/** Reads Postgres per request; `next build` must not need a database. */
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const job = await getJob(id);
  return { title: job?.title ?? "Job not found" };
}

export default async function JobDetailPage({ params }: PageProps) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();

  // The timeline, command metadata and artifact metadata are independent reads.
  // Fetch them together; command transcripts and artifact content stay bounded
  // and are fetched separately from the live event stream.
  const [events, commandSummaries, artifactSummaries] = await Promise.all([
    listEvents(job.id),
    listCommands(job.id),
    listArtifacts(job.id),
  ]);

  const latestArtifact = (
    type:
      | "diff"
      | "implementation_summary"
      | "implementation_plan"
      | "validation_report"
      | "review_report",
  ) => {
    for (let index = artifactSummaries.length - 1; index >= 0; index -= 1) {
      const artifact = artifactSummaries[index];
      if (artifact?.type === type) return artifact;
    }
    return null;
  };

  const latestDiff = latestArtifact("diff");
  const latestSummary = latestArtifact("implementation_summary");
  const latestPlan = latestArtifact("implementation_plan");
  const latestValidation = latestArtifact("validation_report");
  const latestReview = latestArtifact("review_report");
  const [diff, summary, plan, validation, review] = await Promise.all([
    latestDiff ? getArtifact(job.id, latestDiff.id) : Promise.resolve(null),
    latestSummary ? getArtifact(job.id, latestSummary.id) : Promise.resolve(null),
    latestPlan ? getArtifact(job.id, latestPlan.id) : Promise.resolve(null),
    latestValidation ? getArtifact(job.id, latestValidation.id) : Promise.resolve(null),
    latestReview ? getArtifact(job.id, latestReview.id) : Promise.resolve(null),
  ]);
  const finished = isTerminal(job.status);

  return (
    <JobLiveProvider
      jobId={job.id}
      initialStatus={job.status}
      initialEvents={events.map(serializeJobEvent)}
      initialCommandSummaries={commandSummaries.map(serializeJobCommandSummary)}
      initialUsage={{
        totalInputTokens: job.totalInputTokens,
        totalOutputTokens: job.totalOutputTokens,
        totalCostUsd: job.totalCostUsd,
      }}
    >
      <div className="space-y-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-3">
            <Link href="/" className="text-muted-foreground text-xs hover:underline">
              Back to jobs
            </Link>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{job.title}</h1>
              <LiveStatusBadge />
            </div>
            <p className="text-muted-foreground font-mono text-xs">{job.id}</p>
          </div>

          <div className="border-border/70 bg-muted/20 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="text-muted-foreground">Duration</span>
              <span className="font-mono tabular-nums">
                {formatElapsed(job.startedAt, job.completedAt)}
              </span>
            </div>
            <span aria-hidden className="bg-border hidden h-4 w-px sm:block" />
            <LiveAgentUsage />
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Description</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{job.description}</p>
              </CardContent>
            </Card>

            <ImplementationPlanPanel artifact={plan} />

            <ValidationPanel artifact={validation} />

            <ReviewPanel artifact={review} job={job} />

            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle>Execution timeline</CardTitle>
                  <LiveConnectionIndicator />
                </div>
              </CardHeader>
              <CardContent>
                <LiveExecutionTimeline />
              </CardContent>
            </Card>

            <JobArtifactsPanel artifacts={artifactSummaries} summary={summary} diff={diff} />

            <Card>
              <CardHeader>
                <CardTitle>Sandbox commands</CardTitle>
              </CardHeader>
              <CardContent>
                <LiveCommandLog />
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Execution</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  rows={[
                    // Postgres's counter, not BullMQ's: this includes reclaims
                    // after a crash that the queue never learned about.
                    ["Attempts", String(job.attemptCount)],
                    ["Duration", formatElapsed(job.startedAt, job.completedAt)],
                    [
                      "Failure category",
                      job.failureCategory ? FAILURE_CATEGORY_LABELS[job.failureCategory] : "none",
                    ],
                  ]}
                />

                {finished ? null : (
                  <div className="mt-5 space-y-2">
                    {job.cancelRequestedAt ? (
                      <p className="text-muted-foreground text-xs">
                        Cancellation requested at {formatDateTime(job.cancelRequestedAt)}. The
                        worker stops between phases, so this can take a heartbeat interval.
                      </p>
                    ) : null}
                    <CancelJobButton jobId={job.id} />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Target</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  rows={[
                    ["Repository", job.repoUrl, "break-all font-mono text-xs"],
                    ["Base branch", job.baseBranch, "font-mono text-xs"],
                    [
                      "Base commit",
                      job.baseCommitSha ?? "resolved at run time",
                      "font-mono text-xs",
                    ],
                    ["Final branch", job.finalBranch ?? "not yet", "font-mono text-xs"],
                    [
                      "Pull request",
                      // The deliverable, so it is a link the moment one exists
                      // rather than a URL the reader has to select and paste.
                      job.pullRequestUrl ? (
                        <ExternalLink href={job.pullRequestUrl}>
                          {job.pullRequestNumber === null
                            ? "View pull request"
                            : `#${String(job.pullRequestNumber)}`}
                        </ExternalLink>
                      ) : (
                        "not yet"
                      ),
                      "break-all font-mono text-xs",
                    ],
                    ...(job.issueUrl || job.issueNumber !== null
                      ? ([
                          [
                            "Issue",
                            job.issueUrl ? (
                              <ExternalLink href={job.issueUrl}>
                                {job.issueNumber === null
                                  ? "View issue"
                                  : `#${String(job.issueNumber)}`}
                              </ExternalLink>
                            ) : (
                              `#${String(job.issueNumber)}`
                            ),
                            "font-mono text-xs",
                          ],
                        ] as const)
                      : []),
                    ...(job.githubInstallationId === null
                      ? []
                      : ([
                          ["Installation", String(job.githubInstallationId), "font-mono text-xs"],
                        ] as const)),
                  ]}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Environment fingerprint</CardTitle>
              </CardHeader>
              <CardContent>
                {job.envFingerprint ? (
                  <pre className="max-h-96 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-words">
                    {JSON.stringify(job.envFingerprint, null, 2)}
                  </pre>
                ) : (
                  <p className="text-muted-foreground text-sm">Not recorded yet.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Budget</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  rows={[
                    ["Max duration", formatDuration(job.maxDurationSeconds)],
                    ["Max cost", formatUsd(job.maxCostUsd)],
                    ["Max model calls", String(job.maxModelCalls)],
                    ["Max tool calls", String(job.maxToolCalls)],
                    ["Priority", String(job.priority)],
                  ]}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Timestamps</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  rows={[
                    ["Created", formatDateTime(job.createdAt)],
                    ["Updated", formatDateTime(job.updatedAt)],
                    ["Started", formatDateTime(job.startedAt)],
                    ["Completed", formatDateTime(job.completedAt)],
                  ]}
                />
              </CardContent>
            </Card>

            {job.failureReason ? (
              <Card>
                <CardHeader>
                  <CardTitle>Failure reason</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-destructive text-sm">{job.failureReason}</p>
                </CardContent>
              </Card>
            ) : null}
          </div>
        </div>
      </div>
    </JobLiveProvider>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
    >
      {children}
    </a>
  );
}

function DetailList({ rows }: { rows: readonly (readonly [string, React.ReactNode, string?])[] }) {
  return (
    <dl className="space-y-3 text-sm">
      {rows.map(([label, value, valueClassName]) => (
        <div key={label} className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground shrink-0 text-xs">{label}</dt>
          <dd className={valueClassName ?? "text-right"}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
