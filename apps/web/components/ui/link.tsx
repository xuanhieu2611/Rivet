import { ArrowUpRight } from "lucide-react";
import NextLink from "next/link";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * The link treatment, in one place.
 *
 * Every anchor in the app used to spell `text-sky-700 dark:text-sky-300`
 * itself, which is how a product ends up with two accents and no way to change
 * either. Colour now comes from the `--link` token; these two components exist
 * so nothing has to remember that.
 */
const linkClassName = "text-link underline-offset-2 hover:underline";

/** An in-app destination. Prefetched and client-routed like any `next/link`. */
export function AppLink({ className, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink className={cn(linkClassName, className)} {...props} />;
}

/**
 * A destination outside Rivet - a pull request, an issue, the repository.
 *
 * The arrow is not decoration: these are the only links in the product that
 * leave it, and `target="_blank"` is a surprise worth signposting. It is
 * `aria-hidden` because the `rel`/`target` pair is what assistive technology
 * actually reads.
 */
export function ExternalLink({
  className,
  children,
  showIcon = true,
  ...props
}: ComponentProps<"a"> & { showIcon?: boolean }) {
  return (
    <a
      target="_blank"
      rel="noreferrer noopener"
      className={cn(linkClassName, showIcon && "inline-flex items-center gap-1", className)}
      {...props}
    >
      {children}
      {showIcon ? <ArrowUpRight aria-hidden className="size-3.5 shrink-0" /> : null}
    </a>
  );
}

/** An anchor within the current page, such as a jump to the command transcript. */
export function AnchorLink({ className, ...props }: ComponentProps<"a">) {
  return <a className={cn(linkClassName, className)} {...props} />;
}
