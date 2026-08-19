import type { Metadata } from "next";
import Link from "next/link";

import { NewJobForm } from "@/components/new-job-form";
import { requirePageSession } from "@/lib/auth/page-guard";
import { resolveGitHubWebConfig } from "@/lib/github/config";

export const metadata: Metadata = { title: "New job" };

/**
 * Reads `RIVET_GITHUB` per request, so it must not be prerendered - a build on a
 * machine with no credentials would otherwise bake "GitHub is off" into the page.
 */
export const dynamic = "force-dynamic";

export default async function NewJobPage() {
  await requirePageSession();
  const github = resolveGitHubWebConfig();

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="space-y-2">
        <Link href="/jobs" className="text-muted-foreground text-xs hover:underline">
          Back to jobs
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New job</h1>
        <p className="text-muted-foreground text-sm">
          A worker claims the job, provisions a sandbox, plans, codes, validates and reviews it.
          {github.enabled
            ? " Pick a repository the App is installed on and the run ends in a pull request."
            : " GitHub publication is off here, so a run ends at its validated diff."}
        </p>
      </div>

      <NewJobForm githubEnabled={github.enabled} />
    </div>
  );
}
