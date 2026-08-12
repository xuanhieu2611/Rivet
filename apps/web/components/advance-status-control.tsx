"use client";

import type { JobStatus } from "@rivet/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { ApiErrorBody } from "@/lib/api/responses";
import { nextStatus, statusLabel } from "@/lib/job-status";

/**
 * TODO(M1): delete when the worker drives transitions.
 *
 * Nothing executes jobs in Milestone 0, so a job would sit at `queued` forever
 * and the status pipeline would never be exercised. This control walks a job
 * along the happy path through the same `PATCH /api/jobs/:id` a real client
 * would use, proving enum -> contract -> badge -> refetch end to end.
 *
 * The page only renders it outside production, and the route itself 404s there,
 * so this is belt and braces on purpose.
 */
export function AdvanceStatusControl({ jobId, status }: { jobId: string; status: JobStatus }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const target = nextStatus(status);

  async function advance() {
    if (!target) return;
    setPending(true);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: target }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
        toast.error(body?.error ?? "Could not advance the status.");
        return;
      }
      toast.success(`Status advanced to ${statusLabel(target)}.`);
      router.refresh();
    } catch {
      toast.error("Could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border-border/70 bg-muted/30 space-y-3 rounded-xl border border-dashed p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Development only</p>
        <p className="text-muted-foreground text-xs">
          No worker exists yet, so nothing moves this job on its own. Stepping it manually proves
          the status pipeline works. Removed in Milestone 1.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!target || pending}
          onClick={() => void advance()}
        >
          {pending ? "Advancing…" : "Advance status"}
        </Button>
        {target ? (
          <span className="text-muted-foreground flex items-center gap-2 text-xs">
            next <StatusBadge status={target} />
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">
            Terminal status - nowhere left to go.
          </span>
        )}
      </div>
    </div>
  );
}
