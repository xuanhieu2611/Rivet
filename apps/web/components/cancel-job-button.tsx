"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { ApiErrorBody } from "@/lib/api/responses";

/**
 * The one interactive control on the job detail page.
 *
 * A client component because cancelling is a user action with a result worth
 * reporting, and the three outcomes of `POST /api/jobs/:id/cancel` say different
 * things: `200` stopped it, `202` asked a worker to stop it, `409` means it
 * finished first. Reporting all three as "cancelled" would be a lie in two
 * cases out of three, and the middle one is the interesting one - a job in
 * flight takes up to a heartbeat interval to actually stop.
 *
 * The refresh afterwards synchronizes server-rendered job metadata immediately;
 * the live provider continues to own the event stream and status timeline.
 */
export function CancelJobButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function cancel() {
    setPending(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });

      if (response.status === 202) {
        toast.info("Cancellation requested. The job stops at its next heartbeat.");
      } else if (response.ok) {
        toast.success("Job cancelled.");
      } else {
        const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
        toast.error(body?.error ?? "Could not cancel this job.");
      }

      router.refresh();
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="w-full"
      disabled={pending}
      onClick={() => void cancel()}
    >
      {pending ? "Cancelling…" : "Cancel job"}
    </Button>
  );
}
