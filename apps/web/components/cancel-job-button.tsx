"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Ban, Check, Hourglass, Loader2, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { ApiErrorBody } from "@/lib/api/responses";
import { cn } from "@/lib/utils";

/**
 * What the button has committed to, which is not always what the job is.
 *
 * `requested` is the interesting one and the reason this is a state rather than
 * a boolean: `202` means a worker has been asked to stop and has not stopped
 * yet, so the control must neither claim success nor offer the action again.
 */
type CancelState = "idle" | "cancelling" | "requested" | "cancelled";

const CANCEL_PRESENTATION: Record<CancelState, { label: string; icon: LucideIcon }> = {
  idle: { label: "Cancel job", icon: Ban },
  cancelling: { label: "Cancelling…", icon: Loader2 },
  requested: { label: "Cancellation requested", icon: Hourglass },
  cancelled: { label: "Cancelled", icon: Check },
};

const LABEL_TRANSITION = { duration: 0.18, ease: [0.23, 1, 0.32, 1] } as const;

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
 * The optimistic state is `useOptimistic` rather than a `pending` flag because
 * the two differ precisely where it matters. A flag would have to be cleared by
 * hand on every exit path, and the failing path is the one that gets forgotten;
 * React drops the optimistic value when the transition settles, so a request
 * that never reached the server puts the action back by itself and the button
 * keeps a committed state only when the server actually answered.
 *
 * The refresh afterwards synchronizes server-rendered job metadata immediately;
 * the live provider continues to own the event stream and status timeline.
 */
export function CancelJobButton({
  jobId,
  cancelRequested = false,
}: {
  jobId: string;
  /** Seeded from `jobs.cancel_requested_at`, so a reload does not re-offer the action. */
  cancelRequested?: boolean;
}) {
  const router = useRouter();
  const reduceMotion = useReducedMotion() === true;
  const [committed, setCommitted] = useState<CancelState>(cancelRequested ? "requested" : "idle");
  const [state, setOptimistic] = useOptimistic<CancelState, CancelState>(
    committed,
    (_current, next) => next,
  );
  const [, startTransition] = useTransition();

  function cancel() {
    startTransition(async () => {
      setOptimistic("cancelling");

      try {
        const response = await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });

        if (response.status === 202) {
          setCommitted("requested");
          toast.info("Cancellation requested. The job stops at its next heartbeat.");
        } else if (response.ok) {
          setCommitted("cancelled");
          toast.success("Job cancelled.");
        } else {
          const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
          toast.error(body?.error ?? "Could not cancel this job.");
        }

        router.refresh();
      } catch {
        toast.error("Could not reach the server.");
      }
    });
  }

  const presentation = CANCEL_PRESENTATION[state];
  const Icon = presentation.icon;
  const spinning = state === "cancelling";

  return (
    <Button
      size="sm"
      variant="outline"
      className="w-full"
      disabled={state !== "idle"}
      aria-live="polite"
      onClick={cancel}
    >
      <Icon
        aria-hidden
        className={cn(spinning && !reduceMotion && "animate-spin motion-reduce:animate-none")}
      />
      {reduceMotion ? (
        presentation.label
      ) : (
        <span className="relative inline-flex">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={state}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={LABEL_TRANSITION}
            >
              {presentation.label}
            </motion.span>
          </AnimatePresence>
        </span>
      )}
    </Button>
  );
}
