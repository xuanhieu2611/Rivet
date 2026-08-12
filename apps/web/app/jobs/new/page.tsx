import type { Metadata } from "next";
import Link from "next/link";

import { NewJobForm } from "@/components/new-job-form";

export const metadata: Metadata = { title: "New job" };

export default function NewJobPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="space-y-2">
        <Link href="/" className="text-muted-foreground text-xs hover:underline">
          Back to jobs
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New job</h1>
        <p className="text-muted-foreground text-sm">
          Rivet records the job and shows its status. Nothing runs it yet, so it will sit at{" "}
          <span className="font-medium">queued</span> until Milestone 1 ships the worker.
        </p>
      </div>

      <NewJobForm />
    </div>
  );
}
