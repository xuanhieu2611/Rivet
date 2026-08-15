import {
  repoValidationConfigSchema,
  type RepoValidationConfig,
  type TestFramework,
} from "@rivet/contracts";

import { ValidationConfigInvalidError } from "../jobs/failure";
import type { ProjectPlan } from "./project";
import { readScript } from "./project";

export type ValidationConfigSource = "rivet_json" | "package_json";

export interface ResolvedReporter {
  framework: TestFramework;
  outputArg?: string;
}

export interface ResolvedCheck {
  argv: string[];
  source: ValidationConfigSource;
  timeoutMs?: number;
  reporter?: ResolvedReporter;
}

export interface SkippedCheck {
  skipped: true;
  /** A clause suitable for embedding in a phase's sentence. */
  reason: string;
}

export type ResolvedCheckConfig = ResolvedCheck | SkippedCheck;

export interface ResolvedTargetedCheck extends ResolvedCheck {
  appendPaths: boolean;
}

export type ResolvedTargetedConfig = ResolvedTargetedCheck | SkippedCheck;

export interface ResolvedValidation {
  test: ResolvedCheckConfig;
  typecheck: ResolvedCheckConfig;
  lint: ResolvedCheckConfig;
  targeted: ResolvedTargetedConfig;
}

export interface ResolveValidationConfigInput {
  plan: ProjectPlan;
  manifest: unknown;
  /** Parsed `rivet.json`, or null when the file is absent. */
  repoConfig: unknown;
}

type CheckName = "test" | "typecheck" | "lint";
type RepoCheck = NonNullable<RepoValidationConfig["validation"][CheckName]>;

/**
 * Resolves the commands both validation phases will run.
 *
 * Precedence belongs here, per check, so `analyzing` and `testing` cannot make
 * different choices: an explicit `rivet.json` entry wins, then a non-empty
 * package script is run through the detected package manager, and otherwise
 * the check carries the same sentence-ready skip reason as `probeProject`.
 */
export function resolveValidationConfig(input: ResolveValidationConfigInput): ResolvedValidation {
  const repoConfig = parseRepoConfig(input.repoConfig);
  const testScript = readScript(input.manifest, "test");

  const test = resolveCheck("test", input.plan, input.manifest, repoConfig, testScript);
  const typecheck = resolveCheck("typecheck", input.plan, input.manifest, repoConfig);
  const lint = resolveCheck("lint", input.plan, input.manifest, repoConfig);
  const targeted = resolveTargeted(repoConfig, test);

  return { test, typecheck, lint, targeted };
}

/** Builds the all-skipped result used when the container-side probe cannot read a project. */
export function skippedValidation(reason: string): ResolvedValidation {
  return {
    test: { skipped: true, reason },
    typecheck: { skipped: true, reason },
    lint: { skipped: true, reason },
    targeted: { skipped: true, reason },
  };
}

function parseRepoConfig(value: unknown): RepoValidationConfig | null {
  if (value === null) return null;

  const parsed = repoValidationConfigSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "rivet.json";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  throw new ValidationConfigInvalidError(`Invalid rivet.json validation configuration: ${details}`);
}

function resolveCheck(
  name: CheckName,
  plan: ProjectPlan,
  manifest: unknown,
  repoConfig: RepoValidationConfig | null,
  knownScript?: string | null,
): ResolvedCheckConfig {
  const configured = repoConfig?.validation[name];
  if (configured) return fromRepoCheck(configured);

  const script = knownScript === undefined ? readScript(manifest, name) : knownScript;
  if (script === null) {
    return { skipped: true, reason: `there is no \`${name}\` script in package.json` };
  }

  return {
    argv: plan.runScript(name),
    source: "package_json",
    ...(name === "test" ? reporterFromDetection(manifest, script) : {}),
  };
}

function fromRepoCheck(check: RepoCheck): ResolvedCheck {
  return {
    argv: [...check.argv],
    source: "rivet_json",
    ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
    ...("reporter" in check && check.reporter !== undefined
      ? { reporter: copyReporter(check.reporter) }
      : {}),
  };
}

function resolveTargeted(
  repoConfig: RepoValidationConfig | null,
  test: ResolvedCheckConfig,
): ResolvedTargetedConfig {
  const configured = repoConfig?.validation.targeted;
  if (configured) {
    return {
      ...fromRepoCheck(configured),
      appendPaths: configured.appendPaths,
    };
  }

  if ("skipped" in test) return { ...test };
  return {
    ...test,
    argv: [...test.argv],
    appendPaths: true,
  };
}

function copyReporter(reporter: {
  framework: TestFramework;
  outputArg?: string | undefined;
}): ResolvedReporter {
  return {
    framework: reporter.framework,
    ...(reporter.outputArg === undefined ? {} : { outputArg: reporter.outputArg }),
  };
}

/**
 * Stage 3 replaces this deliberately narrow hook with `detectTestFramework`.
 * Keeping the call in the resolver now makes this the sole place that will
 * decide reporter inference, while Stage 2 remains independent of report
 * parsing and preserves every explicit declaration.
 */
function reporterFromDetection(
  _manifest: unknown,
  _scriptText: string,
): { reporter: ResolvedReporter } | Record<string, never> {
  return {};
}
