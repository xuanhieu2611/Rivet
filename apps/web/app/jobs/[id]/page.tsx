import "server-only";

import { getJob } from "@rivet/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdvanceStatusControl } from "@/components/advance-status-control";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatDuration, formatUsd } from "@/lib/format";

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

  const isDevelopment = process.env.NODE_ENV !== "production";

  return (
    <div className="space-y-8">
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
            <CardContent className="space-y-4">
              <p className="text-muted-foreground text-sm">
                Steps, tool calls and model calls stream in here once the agent runs.{" "}
                <span className="text-foreground font-medium">Arriving in Milestone 3.</span>
              </p>
              <div aria-hidden className="space-y-3 opacity-50">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex items-center gap-3">
                    <Skeleton className="size-6 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-1/3" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
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
              <CardTitle>Timeline</CardTitle>
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

          {/* TODO(M1): delete when the worker drives transitions. */}
          {isDevelopment ? <AdvanceStatusControl jobId={job.id} status={job.status} /> : null}
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
