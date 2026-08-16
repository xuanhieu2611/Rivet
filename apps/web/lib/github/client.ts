import "server-only";

import type { GitHubClient } from "@rivet/core";
import { GitHubPermissionDeniedError, GitHubUnavailableError } from "@rivet/core";
import { getGitHubClient } from "@rivet/github";
import { NextResponse } from "next/server";

import type { ApiErrorBody } from "@/lib/api/responses";
import {
  GITHUB_DISABLED_MESSAGE,
  type GitHubDisabledReason,
  resolveGitHubWebConfig,
} from "@/lib/github/config";

/** Either a usable adapter, or the reason there isn't one. */
export type GitHubAccess =
  { enabled: true; client: GitHubClient } | { enabled: false; reason: GitHubDisabledReason };

/**
 * Resolves the adapter for a route handler.
 *
 * `@rivet/github` constructs its App lazily and memoizes it, so calling this per
 * request costs nothing and keeps the installation-token cache warm across
 * requests - which is the whole reason the adapter memoizes at all.
 */
export function githubAccess(): GitHubAccess {
  const config = resolveGitHubWebConfig();
  if (!config.enabled) return { enabled: false, reason: config.reason };
  return { enabled: true, client: getGitHubClient() };
}

/**
 * 503 with the reason GitHub is unavailable here.
 *
 * Not a 500: nothing went wrong. The deployment is configured this way, and the
 * client's correct response is to show the manual repository field rather than
 * to retry.
 */
export function githubUnavailable(reason: GitHubDisabledReason) {
  return NextResponse.json({ error: GITHUB_DISABLED_MESSAGE[reason] } satisfies ApiErrorBody, {
    status: 503,
  });
}

/**
 * Maps a provider failure to a response, or returns null to let the caller 500.
 *
 * The read-only routes reuse the pipeline's own error classification rather than
 * inventing a second one: a permission denial on the picker means exactly what
 * it means during publication - the App was uninstalled, suspended, or narrowed.
 * Only the transport-level classes are translated; anything else is a real bug
 * and should not be dressed up as a GitHub problem.
 */
export function githubErrorResponse(cause: unknown) {
  if (cause instanceof GitHubPermissionDeniedError) {
    return NextResponse.json(
      {
        error: "GitHub denied this request. Check that the App is still installed on the account.",
      } satisfies ApiErrorBody,
      { status: 403 },
    );
  }

  if (cause instanceof GitHubUnavailableError) {
    return NextResponse.json(
      { error: "GitHub is unavailable right now. Try again in a moment." } satisfies ApiErrorBody,
      { status: 502 },
    );
  }

  return null;
}
