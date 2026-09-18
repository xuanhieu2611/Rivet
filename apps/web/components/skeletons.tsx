import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Placeholders shaped like the content that replaces them.
 *
 * Generic grey bars are worse than nothing: they tell the reader something is
 * loading without telling them what, and the layout still jumps when the real
 * content lands. Each of these mirrors the real component's structure closely
 * enough that the swap is a fill rather than a reflow.
 */

export function PageHeaderSkeleton({ action = false }: { action?: boolean }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      {action ? <Skeleton className="h-8 w-24" /> : null}
    </div>
  );
}

export function TableSkeleton({
  columns,
  rows = 6,
  className,
}: {
  /** Relative column widths, so the skeleton matches the real table's rhythm. */
  columns: readonly string[];
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("border-border overflow-hidden rounded-xl border", className)}>
      <div className="border-border bg-muted/30 flex items-center gap-4 border-b px-4 py-3">
        {columns.map((width, index) => (
          <Skeleton key={index} className={cn("h-3", width)} />
        ))}
      </div>
      <div className="divide-border/60 divide-y">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex items-center gap-4 px-4 py-3.5">
            {columns.map((width, index) => (
              <Skeleton key={index} className={cn("h-4", width)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <Skeleton className="h-4 w-36" />
      </CardHeader>
      <CardContent className="space-y-2.5">
        {Array.from({ length: lines }, (_, line) => (
          <Skeleton key={line} className={cn("h-3.5", line === lines - 1 ? "w-2/3" : "w-full")} />
        ))}
      </CardContent>
    </Card>
  );
}

/** The job detail layout: a wide column of panels beside a sidebar of facts. */
export function TwoColumnSkeleton() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        <Card>
          <CardHeader className="border-b pb-4">
            <Skeleton className="h-4 w-44" />
          </CardHeader>
          <CardContent className="space-y-3 pt-1">
            {Array.from({ length: 8 }, (_, row) => (
              <div key={row} className="flex items-center gap-3">
                <Skeleton className="size-2 shrink-0 rounded-full" />
                <Skeleton className="h-3.5 w-16 shrink-0" />
                <Skeleton className={cn("h-3.5", row % 3 === 0 ? "w-2/3" : "w-1/2")} />
              </div>
            ))}
          </CardContent>
        </Card>
        <CardSkeleton lines={4} />
      </div>
      <div className="space-y-6">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={5} />
      </div>
    </div>
  );
}
