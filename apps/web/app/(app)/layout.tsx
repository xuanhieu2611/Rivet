import Link from "next/link";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-border/60 bg-background/80 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-6">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="text-base font-semibold tracking-tight">Rivet</span>
            <span className="text-muted-foreground hidden text-xs sm:inline">
              autonomous engineering jobs
            </span>
          </Link>
          <nav className="flex items-center gap-4">
            <Link href="/jobs" className="text-muted-foreground hover:text-foreground text-xs">
              Jobs
            </Link>
            <Link
              href="/evaluations"
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              Evaluations
            </Link>
            <Link
              href="/settings/github"
              className="text-muted-foreground hover:text-foreground text-xs"
            >
              GitHub
            </Link>
            <form method="post" action="/api/auth/signout">
              <button type="submit" className="text-muted-foreground hover:text-foreground text-xs">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>

      <footer className="border-border/60 text-muted-foreground border-t">
        <div className="mx-auto w-full max-w-5xl px-6 py-4 text-xs">
          Jobs run with real sandbox provisioning, baseline testing, validation, and sandbox-backed
          coding agent sessions when the worker is configured for Pi.
        </div>
      </footer>
    </div>
  );
}
