import {
  VALIDATION_REPORT_LIMITS,
  type CheckAttribution,
  type TestFramework,
  type TestReport,
} from "@rivet/contracts";

export interface ReporterConfig {
  framework: TestFramework;
  outputArg?: string;
}

const EMPTY_COUNTS = {
  total: 0,
  passed: 0,
  failed: 0,
  skipped: 0,
} as const;

/** Detects a supported test runner without trusting arbitrary manifest shapes. */
export function detectTestFramework(manifest: unknown, scriptText: string): TestFramework | null {
  for (const dependencyField of ["devDependencies", "dependencies"] as const) {
    const dependencies = objectProperty(manifest, dependencyField);
    if (hasDependency(dependencies, "vitest")) return "vitest";
    if (hasDependency(dependencies, "jest")) return "jest";
  }

  if (commandNamesRunner(scriptText, "vitest")) return "vitest";
  if (commandNamesRunner(scriptText, "jest")) return "jest";
  return null;
}

/**
 * Returns the shell-free argv suffix used by both recognised JSON reporters.
 * An explicit output argument is repository configuration and is preserved
 * exactly. Only an output path that argv cannot carry safely disables parsing.
 */
export function reporterArgs(reporter: ReporterConfig, outputPath: string): string[] | null {
  if (outputPath.length === 0 || outputPath.includes("\0")) return null;
  const jsonReporterArg = reporter.framework === "vitest" ? "--reporter=json" : "--json";
  return [jsonReporterArg, reporter.outputArg ?? "--outputFile", outputPath];
}

export function parseVitestJson(text: string): TestReport {
  return parseTestJson("vitest", text);
}

export function parseJestJson(text: string): TestReport {
  return parseTestJson("jest", text);
}

/** Computes the stable, bounded set differences used for failure attribution. */
export function attribute(
  baseline: Pick<TestReport, "failures">,
  after: Pick<TestReport, "failures">,
): CheckAttribution {
  const beforeSet = new Set(baseline.failures);
  const afterSet = new Set(after.failures);

  return {
    newFailures: boundedSorted([...afterSet].filter((name) => !beforeSet.has(name))),
    preExistingFailures: boundedSorted([...afterSet].filter((name) => beforeSet.has(name))),
    fixedFailures: boundedSorted([...beforeSet].filter((name) => !afterSet.has(name))),
  };
}

function parseTestJson(framework: TestFramework, text: string): TestReport {
  const unparsed = (): TestReport => ({
    framework,
    ...EMPTY_COUNTS,
    failures: [],
    parsed: false,
  });

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return unparsed();
  }

  if (!isRecord(value)) return unparsed();
  const total = count(value.numTotalTests);
  const passed = count(value.numPassedTests);
  const failed = count(value.numFailedTests);
  const pending = count(value.numPendingTests);
  const todo = value.numTodoTests === undefined ? 0 : count(value.numTodoTests);
  if (total === null || passed === null || failed === null || pending === null || todo === null) {
    return unparsed();
  }
  const skipped = pending + todo;
  if (!Number.isSafeInteger(skipped)) return unparsed();

  const results = value.testResults;
  if (!Array.isArray(results)) return unparsed();

  const failures: string[] = [];
  for (const result of results) {
    if (!isRecord(result) || typeof result.name !== "string") return unparsed();
    if (!Array.isArray(result.assertionResults)) return unparsed();

    const file = repositoryRelativePath(result.name);
    if (file.length === 0) return unparsed();
    for (const assertion of result.assertionResults) {
      if (!isRecord(assertion)) return unparsed();
      if (assertion.status !== "failed") continue;
      if (typeof assertion.fullName !== "string" || assertion.fullName.trim().length === 0) {
        return unparsed();
      }
      failures.push(`${file}::${assertion.fullName}`);
    }
  }

  return {
    framework,
    total,
    passed,
    failed,
    skipped,
    failures: boundedSorted(failures),
    parsed: true,
  };
}

function objectProperty(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const property = value[key];
  return isRecord(property) ? property : null;
}

function hasDependency(dependencies: Record<string, unknown> | null, name: string): boolean {
  return dependencies !== null && Object.hasOwn(dependencies, name);
}

function commandNamesRunner(scriptText: string, runner: TestFramework): boolean {
  const escaped = runner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s/"'=;&|()])${escaped}(?=$|[\\s"';&|()])`, "u").test(scriptText);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reporter paths are absolute in both supported runners. Rivet's sandbox
 * always checks out at `<workdir>/repo`, so stripping the final `repo` segment
 * makes identities survive an M6 replacement container. Conventional source
 * roots cover captured local reports and relative paths remain unchanged.
 */
function repositoryRelativePath(input: string): string {
  const path = input.replace(/^file:\/\//u, "").replaceAll("\\", "/");
  const repoMarker = path.lastIndexOf("/repo/");
  if (repoMarker >= 0) return path.slice(repoMarker + "/repo/".length);

  if (!path.startsWith("/") && !/^[A-Za-z]:\//u.test(path)) {
    return path.replace(/^\.\//u, "");
  }

  const segments = path.split("/").filter(Boolean);
  const rootIndex = segments.findIndex((segment) =>
    ["apps", "packages", "src", "test", "tests", "__tests__"].includes(segment),
  );
  if (rootIndex >= 0) return segments.slice(rootIndex).join("/");
  return segments.at(-1) ?? "";
}

function boundedSorted(names: readonly string[]): string[] {
  return [...new Set(names)].sort().slice(0, VALIDATION_REPORT_LIMITS.maxFailureNames);
}
