import type { NextConfig } from "next";

/**
 * The public site is a static export: HTML, CSS, JS and images, with no server.
 * That is the whole security argument for hosting it publicly while the
 * product itself stays local-only (SECURITY.md) - there is no route here that
 * can read a database, hold a session or start a job, because there is no
 * runtime here at all.
 */
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  agentRules: false,
};

export default nextConfig;
