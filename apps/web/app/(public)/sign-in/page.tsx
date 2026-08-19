import "server-only";

import type { Metadata } from "next";
import Link from "next/link";

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
    <div className="landing-shell mx-auto max-w-md space-y-6 py-16">
      <div className="space-y-2">
        <h1 className="font-landing-display text-2xl font-semibold tracking-tight">
          Sign in to Rivet
        </h1>
        <p className="text-landing-muted text-sm leading-relaxed">
          Rivet uses GitHub only to identify the configured owner. Repository permissions and GitHub
          operations continue to belong to the GitHub App installation.
        </p>
      </div>

      {signedOut ? (
        <p className="text-sm" style={{ color: "var(--landing-pass)" }}>
          You have been signed out.
        </p>
      ) : null}

      {config.mode === "off" ? (
        <div className="space-y-3" style={{ borderTop: "1px solid var(--landing-rule)" }}>
          <p className="pt-5 text-sm">Authentication is disabled for this local environment.</p>
          <Link href="/jobs" className="landing-cta inline-block">
            Continue to jobs
          </Link>
        </div>
      ) : config.enabled ? (
        <a href="/api/auth/signin" className="landing-cta inline-block">
          Continue with GitHub
        </a>
      ) : (
        <p
          className="text-destructive text-sm"
          style={{ borderTop: "1px solid var(--landing-rule)" }}
        >
          <span className="block pt-5">{AUTH_UNCONFIGURED_MESSAGE}</span>
        </p>
      )}
    </div>
  );
}
