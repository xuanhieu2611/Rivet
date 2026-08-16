/**
 * The web app's half of `RIVET_GITHUB`.
 *
 * The worker refuses `off` under `NODE_ENV=production` because a worker that
 * silently skips publication looks healthy. The web app's stake is different and
 * milder: with GitHub off, or with no App credentials on the machine, the
 * repository and issue pickers cannot answer, so the create form must fall back
 * to the manual URL it has always had rather than offering a picker that returns
 * an error on every keystroke.
 *
 * A pure function of an env object, tested directly, so `next build` on a
 * machine with no credentials resolves `disabled` rather than throwing.
 */
export type GitHubWebConfig =
  { enabled: true; appSlug: string | null } | { enabled: false; reason: GitHubDisabledReason };

/** Why the GitHub surface is unavailable, in the words the UI shows. */
export type GitHubDisabledReason = "disabled" | "unconfigured";

export const GITHUB_DISABLED_MESSAGE: Record<GitHubDisabledReason, string> = {
  disabled: "GitHub integration is turned off. Set RIVET_GITHUB=app to enable it.",
  unconfigured:
    "GitHub App credentials are missing. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to enable the GitHub surface.",
};

/** The subset of an environment this module reads, so tests can pass a literal. */
export type GitHubWebEnv = Partial<Record<string, string>>;

export function resolveGitHubWebConfig(env: GitHubWebEnv = process.env): GitHubWebConfig {
  if (env.RIVET_GITHUB?.trim() !== "app") return { enabled: false, reason: "disabled" };

  // The adapter reads these lazily and throws on first use. Checking here turns
  // a 500 on every picker request into one honest sentence on the settings page.
  if (!env.GITHUB_APP_ID?.trim() || !env.GITHUB_APP_PRIVATE_KEY?.trim()) {
    return { enabled: false, reason: "unconfigured" };
  }

  const appSlug = env.GITHUB_APP_SLUG?.trim();
  return { enabled: true, appSlug: appSlug === undefined || appSlug === "" ? null : appSlug };
}

/** Where a person goes to install the App on a repository, when the slug is known. */
export function installationUrl(appSlug: string | null): string | null {
  return appSlug ? `https://github.com/apps/${appSlug}/installations/new` : null;
}

/** Where a person goes to change what an existing installation can reach. */
export function manageInstallationUrl(installationId: number): string {
  return `https://github.com/settings/installations/${String(installationId)}`;
}
