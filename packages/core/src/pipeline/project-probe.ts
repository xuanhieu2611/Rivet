import { commandKilledError } from "../sandbox/errors";
import { ValidationConfigInvalidError } from "../jobs/failure";
import { splitLines } from "./command-output";
import type { PhaseContext, RecordedCommand } from "./phase-context";
import { detectPackageManager, type ProjectPlan, readScript } from "./project";
import {
  resolveValidationConfig,
  type ResolvedValidation,
  skippedValidation,
} from "./validation-config";

/**
 * Working out what the repository's test suite is, from inside the sandbox.
 *
 * Shared by the two phases that have to agree about the answer. `analyzing`
 * establishes the baseline by running a script; `testing` re-runs it and
 * compares. If those two reached the conclusion separately they would eventually
 * reach different ones - a manifest edited by the session, a lockfile added
 * mid-run - and a comparison between two different commands is not a comparison.
 * Detection lives here so that "the same script the baseline ran" is a property
 * of the code rather than of two copies of it staying in step.
 *
 * `project.ts` is where the pure half lives and stays pure: it maps a directory
 * listing and a manifest to a plan and imports nothing. This module is the half
 * that needs a container, which is why it takes a `PhaseContext` and why it is
 * not in that file.
 */

/**
 * The manifest is read with a cap of its own, well above the default.
 *
 * The default output cap is tuned for transcripts, and a `package.json` clipped
 * at 64KB is not a smaller manifest - it is invalid JSON. A repository with a
 * manifest bigger than this exists, but it does not exist yet.
 */
const MANIFEST_MAX_BYTES = 1_048_576;

/** A repository config is small, but receives the manifest cap so truncation is unambiguous. */
const REPO_CONFIG_MAX_BYTES = MANIFEST_MAX_BYTES;

export interface ProjectProbe {
  /** The project as detected, or null when there is no script to run. */
  plan: ProjectPlan | null;
  /**
   * A clause naming why there is nothing to run. Present exactly when `plan` is
   * null, and phrased to be embedded in whatever sentence the caller is
   * building: `analyzing` says no baseline was established, `testing` says
   * nothing could be verified, and both name the same cause.
   */
  reason: string | null;
}

export interface ProjectProbeOptions {
  /** The clone's directory inside the sandbox. */
  repoDir: string;
  /** The ordinary per-command budget. Nothing here runs the suite itself. */
  commandTimeoutMs: number;
  /** The `package.json` script the caller intends to run. */
  script: string;
}

export type ValidationProbeOptions = Omit<ProjectProbeOptions, "script">;

/**
 * Reads the repository root and its manifest, and says what can be run.
 *
 * Four ways of returning `null`, all of them recorded facts rather than
 * failures: no readable root, no readable manifest, a manifest that is not JSON,
 * and a manifest with no such script. A repository with no tests is not a broken
 * job, and neither is one whose manifest this milestone could not make sense of
 * after an install that plainly could.
 *
 * The package manager is re-detected on every call rather than carried between
 * phases. One cheap `ls` beats threading state through a column another phase
 * wrote, and it keeps each phase runnable on its own - which is what Milestone 6
 * needs when it resumes a job into an existing sandbox.
 *
 * What it does not swallow is a killed command. A timeout or an OOM is a fact
 * about the sandbox rather than about the repository, so it is raised and the
 * caller's phase fails on it.
 */
export async function probeProject(
  ctx: PhaseContext,
  options: ProjectProbeOptions,
): Promise<ProjectProbe> {
  const listing = await ctx.exec({
    argv: ["ls", "-1", "-a", options.repoDir],
    cwd: options.repoDir,
    timeoutMs: options.commandTimeoutMs,
  });
  guard(ctx, listing);

  const plan = listing.exitCode === 0 ? detectPackageManager(splitLines(listing.stdout)) : null;
  if (!plan) {
    return { plan: null, reason: "the repository root could not be read" };
  }

  const manifest = await ctx.exec({
    argv: ["cat", "package.json"],
    cwd: options.repoDir,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: MANIFEST_MAX_BYTES,
  });
  guard(ctx, manifest);

  // A truncated manifest is not a smaller manifest, and one that happened to
  // still parse would be worse than one that did not.
  if (manifest.exitCode !== 0 || manifest.truncated) {
    return { plan: null, reason: "package.json could not be read" };
  }

  const script = parseManifest(manifest.stdout, options.script);
  if (script === undefined) {
    return { plan: null, reason: "package.json is not readable as JSON" };
  }
  if (script === null) {
    return { plan: null, reason: `there is no \`${options.script}\` script in package.json` };
  }

  return { plan, reason: null };
}

/**
 * Reads the inputs to the pure validation resolver from inside the sandbox.
 *
 * Like `probeProject`, killed commands escape and ordinary repository problems
 * become skip reasons. The deliberate exception is a present `rivet.json`:
 * unreadable, truncated, malformed, or schema-invalid configuration is
 * terminal because silently ignoring it could run checks the repository
 * explicitly replaced.
 */
export async function probeValidation(
  ctx: PhaseContext,
  options: ValidationProbeOptions,
): Promise<ResolvedValidation> {
  const listing = await ctx.exec({
    argv: ["ls", "-1", "-a", options.repoDir],
    cwd: options.repoDir,
    timeoutMs: options.commandTimeoutMs,
  });
  guard(ctx, listing);

  const entries = listing.exitCode === 0 ? splitLines(listing.stdout) : [];
  const plan = listing.exitCode === 0 ? detectPackageManager(entries) : null;
  if (!plan) return skippedValidation("the repository root could not be read");

  const manifest = await ctx.exec({
    argv: ["cat", "package.json"],
    cwd: options.repoDir,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: MANIFEST_MAX_BYTES,
  });
  guard(ctx, manifest);
  if (manifest.exitCode !== 0 || manifest.truncated) {
    return skippedValidation("package.json could not be read");
  }

  const parsedManifest = parseJson(manifest.stdout);
  if (!parsedManifest.ok) {
    return skippedValidation("package.json is not readable as JSON");
  }

  let repoConfig: unknown = null;
  if (entries.includes("rivet.json")) {
    const config = await ctx.exec({
      argv: ["cat", "rivet.json"],
      cwd: options.repoDir,
      timeoutMs: options.commandTimeoutMs,
      maxOutputBytes: REPO_CONFIG_MAX_BYTES,
    });
    guard(ctx, config);

    if (config.exitCode !== 0 || config.truncated) {
      throw new ValidationConfigInvalidError(
        "rivet.json is present but could not be read completely",
      );
    }
    const parsedConfig = parseJson(config.stdout);
    if (!parsedConfig.ok) {
      throw new ValidationConfigInvalidError("rivet.json is not readable as JSON");
    }
    // `null` means "file absent" at the pure resolver boundary. The probe
    // knows the file is present, so JSON `null` must not be mistaken for that
    // sentinel and silently ignored.
    if (parsedConfig.value === null) {
      throw new ValidationConfigInvalidError("Invalid rivet.json validation configuration");
    }
    repoConfig = parsedConfig.value;
  }

  return resolveValidationConfig({ plan, manifest: parsedManifest.value, repoConfig });
}

/**
 * `undefined` for unparseable, `null` for absent, the script otherwise.
 *
 * Three answers rather than two because they are three different facts, and the
 * timeline says which. Unparseable should be impossible here - the install in
 * `provisioning` already read this file successfully - so it means something
 * stranger than a bad manifest, and it still is not worth failing a job over.
 */
function parseManifest(text: string, script: string): string | null | undefined {
  try {
    return readScript(JSON.parse(text), script);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Stops the probe for the two things that are the sandbox's fault.
 *
 * Everything else about a command here is information rather than failure, so
 * this deliberately says nothing about exit codes. The abort check comes first
 * for the same reason it does in every other phase: a cancelled job kills the
 * container mid-command, and every command in a killed container comes back
 * looking like a failure of its own.
 */
function guard(ctx: PhaseContext, result: RecordedCommand): void {
  ctx.signal.throwIfAborted();
  const killed = commandKilledError(result);
  if (killed) throw killed;
}
