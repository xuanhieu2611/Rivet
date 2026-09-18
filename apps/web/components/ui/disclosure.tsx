import { ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The one collapsible surface in the app.
 *
 * Nine call sites used to hand-roll `<details>` with copy-pasted summary
 * classes and a literal `▾`, which meant nine chances for the chevron, the
 * rotation, the marker suppression or the keyboard affordance to drift. This
 * owns all four and takes everything that genuinely differs as a prop.
 *
 * `trailing` exists because the chevron is not always the last thing in the
 * summary row: a command header ends with an outcome and a duration, a file
 * diff with its insertion and deletion counts. Those sit in the same flex
 * group as the chevron rather than in `summary`, so the chevron stays pinned
 * to the right edge without each call site re-deciding where to put it.
 */
export interface DisclosureProps extends Omit<ComponentProps<"details">, "children" | "title"> {
  /** Summary content. Takes the remaining width and is allowed to truncate. */
  summary: ReactNode;
  /** Optional content between the summary and the chevron, in the same row. */
  trailing?: ReactNode;
  /** The revealed panel. */
  children: ReactNode;
  summaryClassName?: string;
  /** Wrapper around `children`. Pass `null` to render children bare. */
  contentClassName?: string | null;
}

export function Disclosure({
  summary,
  trailing,
  children,
  className,
  summaryClassName,
  contentClassName,
  ...props
}: DisclosureProps) {
  return (
    <details
      className={cn("group border-border/60 bg-muted/20 rounded-md border", className)}
      {...props}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-3 px-3 py-2 [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        <div className="min-w-0 flex-1">{summary}</div>
        {trailing === undefined ? (
          <DisclosureChevron />
        ) : (
          <div className="flex shrink-0 items-center gap-3">
            {trailing}
            <DisclosureChevron />
          </div>
        )}
      </summary>
      {contentClassName === null ? (
        children
      ) : (
        <div className={cn("border-border/60 border-t px-3 py-3", contentClassName)}>
          {children}
        </div>
      )}
    </details>
  );
}

function DisclosureChevron() {
  return (
    <ChevronDown
      aria-hidden
      className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 group-open:rotate-180"
    />
  );
}
