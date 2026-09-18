import { Plus } from "lucide-react";
import Link from "next/link";

import { AccountMenu } from "@/components/account-menu";
import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/link";
import { readPageSessionLogin } from "@/lib/auth/page-guard";
import { resolveAppChrome } from "@/lib/app-chrome";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const [login, chrome] = [await readPageSessionLogin(), resolveAppChrome()];

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-border bg-background/85 sticky top-0 z-20 border-b backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className="bg-primary inline-block size-2 shrink-0 rounded-full"
            />
            <span className="text-[15px] font-semibold tracking-tight">Rivet</span>
          </Link>

          <AppNav className="min-w-0 flex-1" />

          {/*
            Starting a job used to be reachable only from `/jobs`, which made
            the product's one write action a thing you navigated to rather than
            a thing you did.
          */}
          <Button asChild size="sm" className="shrink-0">
            <Link href="/jobs/new">
              <Plus aria-hidden />
              <span className="hidden sm:inline">New job</span>
              <span className="sr-only sm:hidden">New job</span>
            </Link>
          </Button>

          <AccountMenu login={login} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">{children}</main>

      <footer className="border-border text-muted-foreground border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-5 text-xs">
          <span className="font-mono" title="RIVET_SERVICE_VERSION">
            Rivet {chrome.version}
          </span>
          <ExternalLink href={chrome.docsUrl}>Docs</ExternalLink>
          <ExternalLink href={chrome.repoUrl}>Source</ExternalLink>
        </div>
      </footer>
    </div>
  );
}
