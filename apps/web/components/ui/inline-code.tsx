import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A literal inside a sentence - a command to type, an environment variable, a
 * path a reviewer named.
 *
 * The empty-state on `/evaluations` told the reader to run `pnpm eval:run`
 * inside a bare `<code>` element, which a browser renders as monospace body
 * text and nothing else: an instruction to type something looked exactly like
 * the sentence around it. The surface comes from the `--code` token so this
 * stays one decision rather than a class pair copied per call site.
 *
 * This is for code in prose. The timeline's argv rows, the diff viewer's file
 * paths and the command log are code *cells* - they own their surface already,
 * and wrapping them here would put a pill inside a pill.
 */
export function InlineCode({ className, ...props }: ComponentProps<"code">) {
  return (
    <code
      className={cn(
        "bg-code text-code-foreground rounded px-1.5 py-0.5 font-mono text-[0.85em]",
        className,
      )}
      {...props}
    />
  );
}
