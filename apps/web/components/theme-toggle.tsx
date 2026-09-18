"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  parseThemePreference,
  THEME_PREFERENCES,
  THEME_SETTER,
  type ThemePreference,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: Record<ThemePreference, { label: string; icon: LucideIcon }> = {
  system: { label: "System", icon: Monitor },
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
};

/**
 * A three-way theme preference.
 *
 * It owns no theme state of its own: the pre-paint script in the root layout
 * is still the only thing that decides what `dark` means, and this calls its
 * setter. The current preference is read back off `data-theme` after
 * hydration, so the server renders the same markup for every viewer - which is
 * what keeps a per-viewer preference out of a server component's output.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [preference, setPreference] = useState<ThemePreference | null>(null);

  useEffect(() => {
    setPreference(parseThemePreference(document.documentElement.getAttribute("data-theme")));
  }, []);

  function select(next: ThemePreference) {
    const setter = (window as unknown as Record<string, unknown>)[THEME_SETTER];
    if (typeof setter === "function") (setter as (value: ThemePreference) => void)(next);
    setPreference(next);
  }

  return (
    <div className={cn("flex items-center justify-between gap-3 px-2 py-1.5", className)}>
      <span id="theme-label" className="text-sm">
        Theme
      </span>
      <div
        role="radiogroup"
        aria-labelledby="theme-label"
        className="bg-muted/60 flex items-center gap-0.5 rounded-md p-0.5"
      >
        {THEME_PREFERENCES.map((value) => {
          const option = OPTIONS[value];
          // Null until the effect runs, so nothing is marked selected during the
          // render the server and the browser are compared against.
          const selected = preference === value;

          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.label}
              title={option.label}
              onClick={() => select(value)}
              data-selected={selected ? "" : undefined}
              className={cn(
                "flex items-center justify-center rounded-sm p-1.5 transition-colors duration-150",
                selected
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <option.icon aria-hidden className="size-3.5 shrink-0" />
              {/* The group is labelled in words; each option carries its own name. */}
              <span className="sr-only">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
