import "server-only";

import { isTerminal, type JobSummary } from "@rivet/contracts";
import { listJobs } from "@rivet/core";
import { Filter, Inbox } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { JobsLiveRefresh } from "@/components/jobs-live-refresh";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status-badge";
import { pipelinePhaseIndex, PIPELINE_PHASES } from "@/components/job-live/phase-progress";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePageSession } from "@/lib/auth/page-guard";
import { shortenRepoUrl } from "@/lib/format";
import {
  JOB_FILTERS,
  JOB_FILTER_LABELS,
  jobFilterHref,
  jobFilterStatuses,
  parseJobFilter,
  type JobFilter,
} from "@/lib/job-filter";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Jobs" };

/**
 * Reads Postgres on every request, so it must never be prerendered - `next build`
 * has no database. The filter is a search param rather than client state, which
 * is what keeps this a server component and a filtered view linkable; the only
 * client code on the page is the island that asks for a fresh render while
 * something is still moving.
 */
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  await requirePageSession();
  const params = await searchParams;
  const filter = parseJobFilter(params.status);
  const statuses = jobFilterStatuses(filter);
  const jobs = await listJobs({ limit: 50, ...(statuses ? { statuses } : {}) });
  const activeCount = jobs.filter((job) => !isTerminal(job.status)).length;

  return (
    <div className="space-y-6">
      <JobsLiveRefresh activeCount={activeCount} />

      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-muted-foreground text-sm">{describeList(jobs, filter, activeCount)}</p>
        </div>
        <Button asChild>
          <Link href="/jobs/new">New job</Link>
        </Button>
      </div>

      <JobFilterTabs active={filter} />

      {jobs.length === 0 ? (
        filter === "all" ? (
          <EmptyState
            icon={Inbox}
            title="Nothing queued"
            action={
              <Button asChild>
                <Link href="/jobs/new">Create the first job</Link>
              </Button>
            }
          >
            Describe a change and point Rivet at a repository. A worker picks it up and walks it
            through the pipeline; when configured, the coding agent works inside the job sandbox.
          </EmptyState>
        ) : (
          <EmptyState
            icon={Filter}
            title={`No ${JOB_FILTER_LABELS[filter].toLowerCase()} jobs`}
            action={
              <Button asChild variant="outline">
                <Link href={jobFilterHref("all")}>Show all jobs</Link>
              </Button>
            }
          >
            Nothing in the newest 50 jobs matches this filter.
          </EmptyState>
        )
      ) : (
        <div className="border-border overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell className="font-medium">
                    <Link href={`/jobs/${job.id}`} className="hover:underline">
                      {job.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-sm">
                    {shortenRepoUrl(job.repoUrl)}
                    <span> @ {job.baseBranch}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <LivePulse active={!isTerminal(job.status)} />
                      <StatusBadge status={job.status} />
                      <PhaseHint job={job} />
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-sm whitespace-nowrap">
                    <RelativeTime value={job.createdAt} />
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

function JobFilterTabs({ active }: { active: JobFilter }) {
  return (
    <nav aria-label="Filter jobs by status" className="flex gap-1">
      {JOB_FILTERS.map((filter) => {
        const selected = filter === active;
        return (
          <Link
            key={filter}
            href={jobFilterHref(filter)}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "focus-visible:ring-ring rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {JOB_FILTER_LABELS[filter]}
          </Link>
        );
      })}
    </nav>
  );
}

/** The only thing on a row that says "this is still happening". */
function LivePulse({ active }: { active: boolean }) {
  if (!active) return <span aria-hidden className="size-1.5 shrink-0" />;

  return (
    <span aria-hidden className="relative flex size-1.5 shrink-0">
      <span className="bg-primary/60 absolute inline-flex size-full animate-ping rounded-full motion-reduce:hidden" />
      <span className="bg-primary relative inline-flex size-1.5 rounded-full" />
    </span>
  );
}

/**
 * How far along an active job is, in the same seven segments the detail page
 * steps through. Only rendered for a status that is actually one of them -
 * `queued` has not started and `revising` is a loop rather than a position.
 */
function PhaseHint({ job }: { job: JobSummary }) {
  const index = isTerminal(job.status) ? null : pipelinePhaseIndex(job.status);
  if (index === null) return null;

  return (
    <span className="text-muted-foreground text-xs tabular-nums">
      {index}/{PIPELINE_PHASES.length}
    </span>
  );
}

function describeList(jobs: readonly JobSummary[], filter: JobFilter, activeCount: number): string {
  if (jobs.length === 0) {
    return filter === "all"
      ? "No jobs yet."
      : `No ${JOB_FILTER_LABELS[filter].toLowerCase()} jobs.`;
  }

  const count = `${String(jobs.length)} job${jobs.length === 1 ? "" : "s"}`;
  const scope = filter === "all" ? count : `${count} ${JOB_FILTER_LABELS[filter].toLowerCase()}`;
  return activeCount === 0
    ? `${scope}, newest first.`
    : `${scope}, newest first. ${String(activeCount)} still running, refreshing live.`;
}
