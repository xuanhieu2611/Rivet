import type { Metadata } from "next";

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
        {children}
        <Toaster />
      </body>
    </html>
  );
}
