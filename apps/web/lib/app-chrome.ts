/**
 * The facts the persistent footer is allowed to state.
 *
 * The footer used to carry release-notes prose - "Jobs run with real sandbox
 * provisioning, baseline testing, validation, and..." - which is a sentence
 * that was true when it was written and has no way of staying true. These are
 * three things that are either verifiable or absent.
 *
 * A pure function of an env object, with no Next.js import and no database
 * read, for the same reason `resolveGitHubWebConfig` is: `next build` runs on a
 * machine with none of this set and must still produce a page.
 */
export interface AppChrome {
  /** `RIVET_SERVICE_VERSION`, the same value that becomes `service.version` on every span. */
  version: string;
  repoUrl: string;
  docsUrl: string;
}

const DEFAULT_REPO_URL = "https://github.com/xuanhieu2611/Rivet";

export function resolveAppChrome(env: Partial<Record<string, string>> = process.env): AppChrome {
  const repoUrl = nonEmpty(env.RIVET_REPO_URL) ?? DEFAULT_REPO_URL;

  return {
    // Matches `resolveWebTelemetryConfig`'s default deliberately: a footer that
    // said "unknown" and a trace that said "0.0.0-dev" would be two answers to
    // one question.
    version: nonEmpty(env.RIVET_SERVICE_VERSION) ?? "0.0.0-dev",
    repoUrl,
    docsUrl: nonEmpty(env.RIVET_DOCS_URL) ?? `${repoUrl}/tree/main/docs`,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
