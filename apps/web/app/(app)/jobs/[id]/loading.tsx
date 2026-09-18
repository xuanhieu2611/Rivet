import { TwoColumnSkeleton } from "@/components/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { JOB_TITLE_VIEW_TRANSITION_NAME } from "@/lib/view-transition";

/**
 * Shaped like the job detail page, down to the seven stepper segments, so the
 * live page fills this in rather than replacing it.
 *
 * The title placeholder carries the job title's view-transition name, because
 * this is the frame a list-to-detail navigation actually lands on: the router
 * commits the route as soon as this renders, and a morph that had nothing to
 * morph into would simply drop the title on the floor.
 */
export default function JobDetailLoading() {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <div className="flex items-center gap-3">
            <Skeleton
              className="h-7 w-72"
              style={{ viewTransitionName: JOB_TITLE_VIEW_TRANSITION_NAME }}
            />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-12 w-56 rounded-[var(--radius)]" />
      </div>

      <div className="space-y-2">
        <div className="flex justify-between">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="flex gap-1.5">
          {[0, 1, 2, 3, 4, 5, 6].map((segment) => (
            <Skeleton key={segment} className="h-1 flex-1 rounded-full" />
          ))}
        </div>
      </div>

      <Skeleton className="h-10 w-full rounded-lg" />

      <TwoColumnSkeleton />
    </div>
  );
}
