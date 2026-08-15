/** JavaScript and TypeScript source extensions supported by M7's Node-only scope. */
const SOURCE_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]);

const SOURCE_DIRECTORIES = new Set(["src", "app", "lib"]);

export type TargetedTestSelection = { paths: string[] } | { skipped: true; reason: string };

/**
 * Selects conventionally related test files from a staged diff.
 *
 * The result depends only on Git paths and exact tracked-file membership. No
 * filesystem probing or model judgement is involved, so the same checkpoint
 * always produces the same selection after recovery.
 */
export function selectTargetedTests(input: {
  changedPaths: string[];
  trackedFiles: string[];
  maxFiles: number;
}): TargetedTestSelection {
  if (input.changedPaths.length === 0) {
    return { skipped: true, reason: "the diff contains no changed paths" };
  }

  const tracked = new Set(input.trackedFiles);
  const extensions = trackedExtensions(input.trackedFiles);
  const selected = new Set<string>();
  let sawSourceOrTest = false;

  for (const changedPath of input.changedPaths) {
    if (isTestPath(changedPath)) {
      sawSourceOrTest = true;
      if (tracked.has(changedPath)) selected.add(changedPath);
      continue;
    }

    const source = splitSourcePath(changedPath);
    if (!source) continue;
    sawSourceOrTest = true;

    for (const stem of counterpartStems(source)) {
      for (const kind of ["test", "spec"] as const) {
        for (const extension of extensions) {
          const candidate = `${stem}.${kind}.${extension}`;
          if (tracked.has(candidate)) selected.add(candidate);
        }
      }
    }
  }

  const paths = [...selected].sort();
  if (paths.length === 0) {
    return {
      skipped: true,
      reason: sawSourceOrTest
        ? "no conventional tracked test files match the changed paths"
        : "the diff contains only non-source files",
    };
  }

  if (paths.length > input.maxFiles) {
    return {
      skipped: true,
      reason: `${paths.length} targeted test files exceed the limit of ${input.maxFiles}`,
    };
  }

  return { paths };
}

function trackedExtensions(paths: readonly string[]): string[] {
  return [...new Set(paths.map(extensionOf).filter(isSourceExtension))].sort();
}

function isSourceExtension(extension: string | null): extension is string {
  return extension !== null && SOURCE_EXTENSIONS.has(extension);
}

function extensionOf(path: string): string | null {
  const filename = path.split("/").at(-1) ?? "";
  const dot = filename.lastIndexOf(".");
  return dot <= 0 || dot === filename.length - 1 ? null : filename.slice(dot + 1).toLowerCase();
}

function isTestPath(path: string): boolean {
  return path.split("/").includes("__tests__") || /\.(?:test|spec)\.[^/]+$/.test(path);
}

interface SourcePath {
  segments: string[];
  stem: string;
}

function splitSourcePath(path: string): SourcePath | null {
  const segments = path.split("/");
  const filename = segments.at(-1);
  const extension = extensionOf(path);
  if (!filename || !isSourceExtension(extension)) return null;

  return {
    segments: segments.slice(0, -1),
    stem: filename.slice(0, -(extension.length + 1)),
  };
}

/** The four conventional locations from decision 6, without kind or extension. */
function counterpartStems(source: SourcePath): string[] {
  const directory = source.segments.join("/");
  const beside = joinPath(directory, source.stem);
  const nested = joinPath(directory, "__tests__", source.stem);

  const sourceDirectoryIndex = nearestSourceDirectory(source.segments);
  const packagePrefix =
    sourceDirectoryIndex < 0 ? [] : source.segments.slice(0, sourceDirectoryIndex);
  const relativeDirectory =
    sourceDirectoryIndex < 0 ? source.segments : source.segments.slice(sourceDirectoryIndex + 1);
  const relativeStem = [...relativeDirectory, source.stem];

  return [
    beside,
    nested,
    joinPath(...packagePrefix, "test", ...relativeStem),
    joinPath(...packagePrefix, "tests", ...relativeStem),
  ];
}

function nearestSourceDirectory(segments: readonly string[]): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment !== undefined && SOURCE_DIRECTORIES.has(segment)) return index;
  }
  return -1;
}

function joinPath(...segments: string[]): string {
  return segments.filter((segment) => segment.length > 0).join("/");
}
