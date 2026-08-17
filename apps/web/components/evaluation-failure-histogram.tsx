import type { EvaluationFailureBucket } from "@rivet/core";

import { formatFailureLabel } from "@/lib/evaluation-presentation";

/**
 * The §24.5 failure histogram, as bars made of a div.
 *
 * Charts are M12's line item; this is a correct table with a width. The two
 * things it must not do are drop the unlabelled bucket and merge derived
 * labels with human ones - half the taxonomy is not machine-decidable, and a
 * histogram that hid either would look more rigorous than the data is.
 */
export function EvaluationFailureHistogram({ buckets }: { buckets: EvaluationFailureBucket[] }) {
  if (buckets.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No run in this suite failed, errored or went ungraded.
      </p>
    );
  }

  const largest = Math.max(...buckets.map((bucket) => bucket.total));

  return (
    <ul className="space-y-2">
      {buckets.map((bucket) => (
        <li key={bucket.label ?? "unlabeled"} className="space-y-1">
          <div className="flex items-baseline justify-between gap-4 text-xs">
            <span className={bucket.label === null ? "text-muted-foreground" : "font-medium"}>
              {formatFailureLabel(bucket.label)}
            </span>
            <span className="text-muted-foreground">
              {bucket.total} ({bucket.auto} auto, {bucket.manual} manual)
            </span>
          </div>
          <div className="bg-muted h-2 overflow-hidden rounded-full">
            <div
              className={bucket.label === null ? "bg-muted-foreground/40 h-2" : "bg-primary/60 h-2"}
              style={{ width: `${String((bucket.total / largest) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
