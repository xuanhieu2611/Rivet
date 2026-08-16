import type { RepoRef } from "@rivet/contracts";

/**
 * Query-string parsing for the read-only GitHub routes.
 *
 * Kept beside the routes rather than in `@rivet/contracts` because these are
 * transport details of three GET handlers, not domain values. `undefined` means
 * "malformed", which the caller turns into a 400; the routes never guess.
 */
export function parseInstallationId(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** Owner and name are required together, exactly as `createJobSchema` requires them. */
export function parseRepoRef(params: URLSearchParams): RepoRef | undefined {
  const owner = params.get("owner")?.trim();
  const name = params.get("name")?.trim();
  if (!owner || !name) return undefined;
  return { owner, name };
}
