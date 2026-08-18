export const AUTH_MODES = ["off", "github"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export type WebAuthConfig =
  | { mode: "off" }
  | {
      mode: "github";
      enabled: true;
      clientId: string;
      clientSecret: string;
      ownerGithubLogin: string;
      sessionSecret: string;
    }
  | { mode: "github"; enabled: false; reason: "unconfigured" };

export type AuthWebEnv = Partial<Record<string, string>>;

export const AUTH_UNCONFIGURED_MESSAGE =
  "GitHub authentication is not configured. Set GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, RIVET_OWNER_GITHUB_LOGIN and RIVET_SESSION_SECRET.";

export function resolveWebAuthConfig(env: AuthWebEnv = process.env): WebAuthConfig {
  const mode = nonEmpty(env.RIVET_AUTH) ?? "off";
  if (mode !== "off" && mode !== "github") {
    throw new Error(`RIVET_AUTH must be one of: ${AUTH_MODES.join(", ")}.`);
  }
  if (mode === "off") return { mode: "off" };

  const clientId = nonEmpty(env.GITHUB_APP_CLIENT_ID);
  const clientSecret = nonEmpty(env.GITHUB_APP_CLIENT_SECRET);
  const ownerGithubLogin = nonEmpty(env.RIVET_OWNER_GITHUB_LOGIN);
  const sessionSecret = nonEmpty(env.RIVET_SESSION_SECRET);
  if (
    !clientId ||
    !clientSecret ||
    !ownerGithubLogin ||
    !sessionSecret ||
    sessionSecret.length < 32
  ) {
    return { mode: "github", enabled: false, reason: "unconfigured" };
  }

  return { mode: "github", enabled: true, clientId, clientSecret, ownerGithubLogin, sessionSecret };
}

/** Production must never run an unauthenticated control plane. */
export function assertWebAuthModeAllowed(mode: AuthMode, nodeEnv?: string): void {
  if (mode === "off" && nodeEnv === "production") {
    throw new Error(
      "RIVET_AUTH=off cannot be used with NODE_ENV=production: the control plane would accept unauthenticated job requests. Set RIVET_AUTH=github, or run the web app outside production.",
    );
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
