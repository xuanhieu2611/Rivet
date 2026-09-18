"use client";

import { DropdownMenu as Primitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A minimal menu over the Radix primitive.
 *
 * Only what the header needs: a trigger, a panel, items and a separator. The
 * primitive is here for the parts a hand-rolled menu gets wrong - focus
 * trapping, escape, click-outside, and returning focus to the trigger.
 */
export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = "end",
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground ring-foreground/10 z-50 min-w-48 overflow-hidden rounded-lg p-1 shadow-lg ring-1",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof Primitive.Item> & { inset?: boolean }) {
  return (
    <Primitive.Item
      className={cn(
        "focus:bg-muted focus:text-foreground relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none",
        "[&>svg]:text-muted-foreground [&>svg]:size-4 [&>svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      className={cn("text-muted-foreground px-2 py-1.5 text-xs font-medium", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn("bg-border -mx-1 my-1 h-px", className)} {...props} />;
}
