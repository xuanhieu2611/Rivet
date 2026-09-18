"use client";

import { LayoutList, Settings, SquareActivity, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/jobs", label: "Jobs", icon: LayoutList },
  { href: "/evaluations", label: "Evaluations", icon: SquareActivity },
  { href: "/settings/github", label: "GitHub", icon: Settings },
];

/**
 * The header's destinations, with the current one marked.
 *
 * The only client code in the app shell, and it is client code for exactly one
 * reason: `usePathname`. Everything else in the header - the identity, the
 * version, the create action - is rendered on the server and passed in.
 */
export function AppNav({ className }: { className?: string }) {
  const pathname = usePathname();

  return (
    <nav className={cn("flex items-center gap-1", className)} aria-label="Main">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            data-active={active ? "" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors duration-150",
              active
                ? "text-foreground bg-muted font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
            )}
          >
            <item.icon aria-hidden className="size-4 shrink-0" />
            {/*
              Hidden text rather than no text: a nav that collapses to bare
              glyphs on a phone leaves the link with no accessible name at all,
              and an icon is never the only affordance here.
            */}
            <span className="sr-only sm:not-sr-only">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A section is current when you are anywhere inside it, so `/jobs/<id>` still
 * highlights Jobs. The boundary check keeps `/settings/github-something` from
 * matching `/settings/github`.
 */
export function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
