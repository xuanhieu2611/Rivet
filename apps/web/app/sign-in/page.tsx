import "server-only";

import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { AUTH_UNCONFIGURED_MESSAGE, resolveWebAuthConfig } from "@/lib/auth/config";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const config = resolveWebAuthConfig();
  const signedOut = params.signed_out === "1";

  return (
    <div className="mx-auto max-w-md space-y-6 py-12">
      <div className="space-y-2">
        <Link href="/" className="text-muted-foreground text-xs hover:underline">
          Rivet
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in to Rivet</h1>
        <p className="text-muted-foreground text-sm">
          Rivet uses GitHub only to identify the configured owner. Repository permissions and GitHub
          operations continue to belong to the GitHub App installation.
        </p>
      </div>

      {signedOut ? <p className="text-sm text-emerald-700">You have been signed out.</p> : null}

      {config.mode === "off" ? (
        <div className="space-y-3 rounded-xl border p-5">
          <p className="text-sm">Authentication is disabled for this local environment.</p>
          <Button asChild>
            <Link href="/">Continue to Rivet</Link>
          </Button>
        </div>
      ) : config.enabled ? (
        <Button asChild>
          <a href="/api/auth/signin">Continue with GitHub</a>
        </Button>
      ) : (
        <p className="text-destructive rounded-xl border p-5 text-sm">
          {AUTH_UNCONFIGURED_MESSAGE}
        </p>
      )}
    </div>
  );
}
