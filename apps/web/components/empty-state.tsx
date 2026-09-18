import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The "there is nothing here" surface, in one place.
 *
 * Three pages spelled the same dashed box themselves. The glyph is the only
 * new part, and it is paired with the heading rather than replacing it - an
 * empty state that says nothing in words is a decoration.
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "border-border rounded-xl border border-dashed px-6 py-16 text-center",
        className,
      )}
    >
      <Icon aria-hidden className="text-muted-foreground/60 mx-auto mb-4 size-8" />
      <h2 className="text-base font-medium">{title}</h2>
      <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm">{children}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
