import "server-only";

import type { Installation } from "@rivet/contracts";
import { listGitHubInstallations, syncGitHubInstallations } from "@rivet/core";
import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePageSession } from "@/lib/auth/page-guard";
import { githubAccess } from "@/lib/github/client";
import {
  GITHUB_DISABLED_MESSAGE,
  installationUrl,
  manageInstallationUrl,
  resolveGitHubWebConfig,
} from "@/lib/github/config";

/** Reads Postgres and GitHub per request; `next build` needs neither. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "GitHub" };

/** The status the install callback hands back, in the words this page shows. */
const SETUP_MESSAGES: Record<string, { tone: "positive" | "neutral" | "negative"; text: string }> =
  {
    installed: { tone: "positive", text: "Installation recorded. Pick it when you create a job." },
    requested: {
      tone: "neutral",
      text: "The install was requested. An organization admin has to approve it before it appears here.",
    },
    unknown: {
      tone: "negative",
      text: "GitHub redirected with an installation this App cannot act on. Nothing was recorded.",
    },
    invalid: {
      tone: "negative",
      text: "The callback carried no usable installation id. Nothing was recorded.",
    },
    failed: {
      tone: "negative",
      text: "GitHub could not be reached while recording the installation. Try reloading.",
    },
  };

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function GitHubSettingsPage({ searchParams }: PageProps) {
  await requirePageSession();
  const params = await searchParams;
  const setupParam = params.setup;
  const setup = typeof setupParam === "string" ? SETUP_MESSAGES[setupParam] : undefined;

  const config = resolveGitHubWebConfig();
  const { installations, staleReason } = await loadInstallations();
  const installUrl = config.enabled ? installationUrl(config.appSlug) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/jobs" className="text-muted-foreground text-sm hover:underline">
          Back to jobs
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">GitHub</h1>
        <p className="text-muted-foreground text-sm">
          Rivet publishes through a GitHub App. Install it on the repositories a job may branch,
          push and open a pull request against.
        </p>
      </div>

      {setup ? (
        <p
          className={
            setup.tone === "positive"
              ? "text-sm text-emerald-700 dark:text-emerald-300"
              : setup.tone === "negative"
                ? "text-destructive text-sm"
                : "text-muted-foreground text-sm"
          }
        >
          {setup.text}
        </p>
      ) : null}

      {config.enabled ? null : (
        <Card>
          <CardHeader>
            <CardTitle>GitHub is not available on this deployment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">{GITHUB_DISABLED_MESSAGE[config.reason]}</p>
            <p className="text-muted-foreground">
              Jobs can still run against a public repository URL. They finish without publishing,
              and the timeline says so.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Installed accounts</CardTitle>
            {installUrl ? (
              <Button asChild size="sm">
                <a href={installUrl} target="_blank" rel="noreferrer noopener">
                  Install the App
                </a>
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {staleReason ? <p className="text-muted-foreground text-xs">{staleReason}</p> : null}

          {installations.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No installations yet.{" "}
              {installUrl
                ? "Install the App on an account, and GitHub sends you back here."
                : "Set GITHUB_APP_SLUG to get an install link on this page."}
            </p>
          ) : (
            <ul className="divide-border/60 divide-y">
              {installations.map((installation) => (
                <InstallationRow key={installation.id} installation={installation} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What the App may do</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-2 text-sm">
          <p>
            Contents and pull requests write, issues and metadata read. Nothing else, and no webhook
            subscriptions.
          </p>
          <p>
            Tokens are minted per operation, scoped to one repository, and never leave the worker
            process. No credential is ever placed in a job sandbox, a command transcript, or a
            timeline row.
          </p>
          <p className="text-amber-700 dark:text-amber-300">
            GitHub sign-in identifies the single configured Rivet owner. The App installation, not
            the sign-in token, controls repository permissions and GitHub operations.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function InstallationRow({ installation }: { installation: Installation }) {
  const permissions = Object.entries(installation.permissions);

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{installation.accountLogin}</span>
          <Badge variant="outline">{installation.accountType}</Badge>
          {installation.suspended ? <Badge variant="destructive">suspended</Badge> : null}
        </div>
        <p className="text-muted-foreground font-mono text-xs">
          installation {String(installation.id)}
        </p>
        {permissions.length > 0 ? (
          <p className="text-muted-foreground text-xs break-words">
            {permissions.map(([name, level]) => `${name}: ${level}`).join(" · ")}
          </p>
        ) : null}
      </div>
      <Button asChild variant="ghost" size="sm">
        <a href={manageInstallationUrl(installation.id)} target="_blank" rel="noreferrer noopener">
          Manage on GitHub
        </a>
      </Button>
    </li>
  );
}

/**
 * Installations from GitHub when it will answer, from Postgres when it will not.
 *
 * The provider is the source of truth, but an unreachable GitHub should not turn
 * this page into an error - the durable rows still tell the reader which
 * accounts Rivet knows about, and the page says the list may be stale rather
 * than pretending it is current.
 */
async function loadInstallations(): Promise<{
  installations: Installation[];
  staleReason: string | null;
}> {
  const access = githubAccess();
  if (!access.enabled) {
    return { installations: await listGitHubInstallations(), staleReason: null };
  }

  try {
    return { installations: await syncGitHubInstallations(access.client), staleReason: null };
  } catch (cause) {
    console.error("[/settings/github]", cause);
    return {
      installations: await listGitHubInstallations(),
      staleReason: "GitHub could not be reached, so this list is Rivet's last known copy.",
    };
  }
}
