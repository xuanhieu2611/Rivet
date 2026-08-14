import type { Metadata } from "next";
import Link from "next/link";

import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Rivet",
    template: "%s · Rivet",
  },
  description: "An autonomous software engineering agent that ships pull requests.",
};

/**
 * Applies the `dark` class from the OS colour scheme before first paint.
 *
 * Rivet has no theme switcher yet, so a four-line inline script beats pulling in
 * a provider: it keeps every page a server component, avoids a flash of the
 * light palette, and still tracks the OS if it changes while the tab is open.
 */
const themeScript = `(function(){var m=window.matchMedia("(prefers-color-scheme: dark)");var a=function(e){document.documentElement.classList.toggle("dark",e.matches)};a(m);m.addEventListener("change",a)})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="bg-background text-foreground min-h-svh antialiased">
        <div className="flex min-h-svh flex-col">
          <header className="border-border/60 bg-background/80 sticky top-0 z-10 border-b backdrop-blur">
            <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-6">
              <Link href="/" className="flex items-baseline gap-2">
                <span className="text-base font-semibold tracking-tight">Rivet</span>
                <span className="text-muted-foreground hidden text-xs sm:inline">
                  autonomous engineering jobs
                </span>
              </Link>
              <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-[11px] font-medium">
                Milestone 5
              </span>
            </div>
          </header>

          <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>

          <footer className="border-border/60 text-muted-foreground border-t">
            <div className="mx-auto w-full max-w-5xl px-6 py-4 text-xs">
              Jobs run with real sandbox provisioning, baseline testing, validation, and
              sandbox-backed coding agent sessions when the worker is configured for Pi.
            </div>
          </footer>
        </div>
        <Toaster />
      </body>
    </html>
  );
}
