import type { Installation, Issue, Repository } from "@rivet/contracts";

import type { ApiErrorBody } from "@/lib/api/responses";

/**
 * The browser's typed view of the three read-only GitHub routes.
 *
 * Every failure - transport, non-2xx, unparseable body - comes back as a
 * sentence rather than a thrown value, because every caller is a picker whose
 * job when GitHub will not answer is to say so and offer the manual repository
 * field instead.
 */
export type GitHubFetch<T> = { ok: true; value: T } | { ok: false; error: string };

async function getJson<T>(path: string): Promise<GitHubFetch<T>> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Accept: "application/json" } });
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }

  const body = (await response.json().catch(() => null)) as (T & ApiErrorBody) | null;
  if (!response.ok) {
    return { ok: false, error: body?.error ?? "GitHub could not be reached." };
  }
  if (!body) return { ok: false, error: "The server returned an unreadable response." };
  return { ok: true, value: body };
}

export function fetchInstallations(): Promise<GitHubFetch<{ installations: Installation[] }>> {
  return getJson("/api/github/installations");
}

export function fetchRepositories(
  installationId: number,
): Promise<GitHubFetch<{ repositories: Repository[] }>> {
  return getJson(`/api/github/repositories?installationId=${String(installationId)}`);
}

export function fetchIssues(
  installationId: number,
  owner: string,
  name: string,
): Promise<GitHubFetch<{ issues: Issue[] }>> {
  const params = new URLSearchParams({
    installationId: String(installationId),
    owner,
    name,
  });
  return getJson(`/api/github/issues?${params.toString()}`);
}
