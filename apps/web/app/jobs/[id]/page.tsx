import "server-only";

import { getJob, listEvents } from "@rivet/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ExecutionTimeline } from "@/components/execution-timeline";
import { JobStatusPoller } from "@/components/job-status-poller";
import { StatusBadge } from "@/components/status-badge";
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

  // Two round trips rather than a join. They are independent reads of the same
  // job and the page needs both in full, so there is nothing for a join to save.
  const events = await listEvents(job.id);

  return (
    <div className="space-y-8">
      {/* TODO(M3): delete when SSE lands. */}
      <JobStatusPoller status={job.status} />

      <div className="space-y-3">
        <Link href="/" className="text-muted-foreground text-xs hover:underline">
          Back to jobs
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{job.title}</h1>
          <StatusBadge status={job.status} />
        </div>
        <p className="text-muted-foreground font-mono text-xs">{job.id}</p>
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

          <Card>
            <CardHeader>
              <CardTitle>Execution timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <ExecutionTimeline events={events} />
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
                  ["Base commit", job.baseCommitSha ?? "resolved at run time", "font-mono text-xs"],
                  ["Final branch", job.finalBranch ?? "not yet", "font-mono text-xs"],
                  ["Pull request", job.pullRequestUrl ?? "not yet", "break-all font-mono text-xs"],
                ]}
              />
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
  );
}

function DetailList({ rows }: { rows: readonly (readonly [string, string, string?])[] }) {
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
