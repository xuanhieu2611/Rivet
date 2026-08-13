/**
 * What the cloned repository is, as far as this milestone can tell.
 *
 * Its own module because two phases need the same answer and neither owns it.
 * `provisioning` decides how to install; `testing` decides how to run the
 * repository's own test script, and it has to reach the same conclusion or the
 * baseline would be established with a manager the tree was not installed with.
 * Detection is pure - it takes a directory listing and a manifest, both read
 * inside the sandbox - so both phases can be tested without a container.
 */

/** Where the working tree lands, relative to the sandbox's workdir. */
export const REPO_DIRNAME = "repo";

/** The package managers this milestone can drive, in lockfile precedence order. */
export const PACKAGE_MANAGERS = ["pnpm", "yarn", "npm", "bun"] as const;
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

export interface ProjectPlan {
  name: PackageManagerName;
  /** The lockfile that decided it, or null when there was none. */
  lockfile: string | null;
  install: string[];
  /** Prints the manager's own version, for the fingerprint. */
  version: string[];
  /** Runs the named `package.json` script. The baseline's whole command. */
  runScript: (script: string) => string[];
  env?: Record<string, string>;
}

/**
 * Corepack will not prompt for a download it cannot ask a human about.
 *
 * `pnpm` and `yarn` are not in the sandbox image; corepack ships with Node and
 * fetches the right one. Without this it stops on an interactive confirmation
 * inside a container with no terminal, and the symptom is an install that hangs
 * until its timeout rather than one that says what it wanted.
 */
export const COREPACK_ENV = { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

/**
 * Which package manager a repository uses, decided by its lockfile.
 *
 * Lockfile-driven rather than `packageManager`-field-driven because the
 * lockfile is the thing the install command has to agree with, and a repository
 * whose field and lockfile disagree is one where the lockfile wins.
 *
 * Returns `null` for anything without a `package.json`, which is the
 * `unsupported_project` case: no lockfile at all is still a Node project and
 * still installable, but no manifest is not a project this milestone can build.
 */
export function detectPackageManager(entries: readonly string[]): ProjectPlan | null {
  const files = new Set(entries);
  if (!files.has("package.json")) return null;

  if (files.has("pnpm-lock.yaml")) {
    return {
      name: "pnpm",
      lockfile: "pnpm-lock.yaml",
      install: ["corepack", "pnpm", "install", "--frozen-lockfile"],
      version: ["corepack", "pnpm", "--version"],
      runScript: (script) => ["corepack", "pnpm", "run", script],
      env: COREPACK_ENV,
    };
  }
  if (files.has("yarn.lock")) {
    return {
      name: "yarn",
      lockfile: "yarn.lock",
      install: ["corepack", "yarn", "install", "--immutable"],
      version: ["corepack", "yarn", "--version"],
      runScript: (script) => ["corepack", "yarn", "run", script],
      env: COREPACK_ENV,
    };
  }
  if (files.has("package-lock.json")) {
    return {
      name: "npm",
      lockfile: "package-lock.json",
      install: ["npm", "ci"],
      version: ["npm", "--version"],
      runScript: (script) => ["npm", "run", script],
    };
  }
  if (files.has("bun.lock") || files.has("bun.lockb")) {
    return {
      name: "bun",
      lockfile: files.has("bun.lock") ? "bun.lock" : "bun.lockb",
      install: ["bun", "install", "--frozen-lockfile"],
      version: ["bun", "--version"],
      runScript: (script) => ["bun", "run", script],
    };
  }

  // A manifest with no lockfile. `npm ci` refuses to run without one, so this
  // is the one case that installs from the manifest and accepts that two runs a
  // week apart may resolve differently - which is exactly what the fingerprint
  // is for.
  return {
    name: "npm",
    lockfile: null,
    install: ["npm", "install", "--no-audit", "--no-fund"],
    version: ["npm", "--version"],
    runScript: (script) => ["npm", "run", script],
  };
}

/**
 * The `scripts` entry a manifest defines, or null.
 *
 * Deliberately tolerant of everything except the answer: a manifest is
 * arbitrary JSON written by someone else, and the only thing this needs from it
 * is whether one string is present. Anything unexpected reads as "no such
 * script", which is a recorded fact rather than a failure.
 */
export function readScript(manifest: unknown, script: string): string | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return null;
  const value = (scripts as Record<string, unknown>)[script];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
