import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Reached through `notFound()` on the detail page, which is also what an
 * id that is not a uuid produces - `getJob` refuses to query for one.
 */
export default function JobNotFound() {
  return (
    <div className="border-border mx-auto max-w-lg rounded-xl border border-dashed px-6 py-16 text-center">
      <h1 className="text-base font-medium">No job with that id.</h1>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">
        Either the id is not a job id, or the job was never created. Nothing about a job is ever
        deleted, so a job that existed still exists.
      </p>
      <Button asChild className="mt-6">
        <Link href="/jobs">Back to jobs</Link>
      </Button>
    </div>
  );
}
