import "server-only";

import Link from "next/link";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, shortenRepoUrl } from "@/lib/format";
import { listJobs } from "@/lib/services/job-service";

/**
 * Reads Postgres on every request, so it must never be prerendered - `next build`
 * has no database. Once Milestone 3 streams live status this becomes a
 * revalidating shell around an SSE-fed client island instead.
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const jobs = await listJobs({ limit: 50 });

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-muted-foreground text-sm">
            {jobs.length === 0
              ? "No jobs yet."
              : `${String(jobs.length)} job${jobs.length === 1 ? "" : "s"}, newest first.`}
          </p>
        </div>
        <Button asChild>
          <Link href="/jobs/new">New job</Link>
        </Button>
      </div>

      {jobs.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed px-6 py-16 text-center">
          <h2 className="text-base font-medium">Nothing queued</h2>
          <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">
            Describe a change and point Rivet at a repository. Milestone 0 persists the job and
            renders its status; execution arrives in Milestone 1.
          </p>
          <Button asChild className="mt-6">
            <Link href="/jobs/new">Create the first job</Link>
          </Button>
        </div>
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
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {shortenRepoUrl(job.repoUrl)}
                    <span className="text-muted-foreground/70"> @ {job.baseBranch}</span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={job.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-right text-xs whitespace-nowrap">
                    {formatDateTime(job.createdAt)}
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
