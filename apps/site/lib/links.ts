export const LINKS = {
  repo: "https://github.com/xuanhieu2611/Rivet",
  architecture: "https://github.com/xuanhieu2611/Rivet/blob/main/docs/architecture.md",
  security: "https://github.com/xuanhieu2611/Rivet/blob/main/SECURITY.md",
  experiment: "https://github.com/xuanhieu2611/Rivet/blob/main/docs/experiments/reviewer-value.md",
  quickStart: "https://github.com/xuanhieu2611/Rivet#quick-start",
  license: "https://github.com/xuanhieu2611/Rivet/blob/main/LICENSE",
  videoId: "X_b03iHhXzU",
  video: "https://youtu.be/X_b03iHhXzU",
  thread: "https://x.com/hieuspringle/status/2091312854389719528",
} as const;

/**
 * The person behind the project. A link left as `null` is not rendered, so
 * adding one later is a one-line change here.
 */
export const AUTHOR = {
  name: "Hieu Le",
  github: "https://github.com/xuanhieu2611",
  x: "https://x.com/hieuspringle",
  linkedin: "https://www.linkedin.com/in/hieule2611/" as string | null,
  website: null as string | null,
} as const;

/**
 * Absolute origin for canonical and social-card URLs. Vercel sets
 * `VERCEL_PROJECT_PRODUCTION_URL` (a bare host) at build time; `SITE_URL`
 * overrides it once the site has a custom domain.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): URL {
  if (env.SITE_URL) return new URL(env.SITE_URL);
  if (env.VERCEL_PROJECT_PRODUCTION_URL)
    return new URL(`https://${env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return new URL("http://localhost:3001");
}
