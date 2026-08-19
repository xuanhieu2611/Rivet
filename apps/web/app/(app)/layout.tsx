import Link from "next/link";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-border bg-background/85 sticky top-0 z-20 border-b backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="bg-primary inline-block size-2 shrink-0 rounded-full"
            />
            <span className="text-[15px] font-semibold tracking-tight">Rivet</span>
          </Link>
          <nav className="flex items-center gap-5">
            <Link
              href="/jobs"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors duration-150"
            >
              Jobs
            </Link>
            <Link
              href="/evaluations"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors duration-150"
            >
              Evaluations
            </Link>
            <Link
              href="/settings/github"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors duration-150"
            >
              GitHub
            </Link>
            <form method="post" action="/api/auth/signout">
              <button
                type="submit"
                className="text-muted-foreground hover:text-foreground text-sm transition-colors duration-150"
              >
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>

      <footer className="border-border text-muted-foreground border-t">
        <div className="mx-auto w-full max-w-5xl px-6 py-5 text-sm leading-relaxed">
          Jobs run with real sandbox provisioning, baseline testing, validation, and sandbox-backed
          coding agent sessions when the worker is configured for Pi.
        </div>
      </footer>
    </div>
  );
}
