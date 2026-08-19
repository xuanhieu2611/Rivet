import { parseDiff, type ChangeData, type FileData, type HunkData } from "react-diff-view";

/** Files above this count start collapsed. A 40-file diff must not be a scroll. */
export const DIFF_FILE_COLLAPSE_THRESHOLD = 8;

const ELISION_RE = /\n?\.\.\. (\d+) bytes elided \.\.\.\n?/;
const GIT_HEADER_RE = /^diff --git (?:a\/(.+)|"a\/(.+)") (?:b\/(.+)|"b\/(.+)")/;
const OLD_MODE_RE = /^(?:old mode|deleted file mode) (\d+)$/m;
const NEW_MODE_RE = /^(?:new mode|new file mode) (\d+)$/m;
const RENAME_FROM_RE = /^rename from (.+)$/m;
const RENAME_TO_RE = /^rename to (.+)$/m;

export type DiffFileKind = "add" | "delete" | "modify" | "rename" | "copy" | "binary" | "mode";

export interface DiffFile {
  kind: DiffFileKind;
  oldPath: string;
  newPath: string;
  oldMode: string | null;
  newMode: string | null;
  hunks: HunkData[];
  insertions: number;
  deletions: number;
  incomplete: boolean;
  similarity: number | null;
}

export type DiffEntry = { type: "file"; file: DiffFile } | { type: "clip"; elidedBytes: number };

export interface ParsedDiffArtifact {
  entries: DiffEntry[];
  files: DiffFile[];
  truncated: boolean;
  byteSize: number;
  elidedBytes: number | null;
}

export interface ParseDiffArtifactInput {
  content: string;
  truncated?: boolean;
  byteSize?: number;
}

/**
 * Turns a stored unified diff into file and clip entries the viewer can render.
 *
 * `parseDiff` is the primitive; this wrapper exists because the capture path
 * already produces shapes the parser does not treat as first-class: literal
 * binary patches, mode-only files, and the head+tail elision marker
 * `recordArtifact` plants when a diff exceeds the artifact cap.
 */
export function parseDiffArtifact(input: ParseDiffArtifactInput): ParsedDiffArtifact {
  const content = input.content;
  const contentBytes = utf8ByteLength(content);
  const byteSize = input.byteSize ?? contentBytes;
  const truncated = input.truncated === true || ELISION_RE.test(content);

  const clipped = splitClipped(content);
  const elidedBytes = truncated
    ? (clipped.elidedBytes ?? Math.max(0, byteSize - contentBytes))
    : null;
  const entries: DiffEntry[] = [];
  if (clipped.head.trim().length > 0) {
    entries.push(
      ...parseSegment(clipped.head, false).map((file) => ({ type: "file" as const, file })),
    );
  }
  if (truncated) {
    entries.push({ type: "clip", elidedBytes: elidedBytes ?? 0 });
  }
  if (clipped.tail !== null && clipped.tail.trim().length > 0) {
    entries.push(
      ...parseSegment(clipped.tail, true).map((file) => ({ type: "file" as const, file })),
    );
  }

  const files = entries.flatMap((entry) => (entry.type === "file" ? [entry.file] : []));
  return {
    entries,
    files,
    truncated,
    byteSize,
    elidedBytes: truncated ? (elidedBytes ?? Math.max(0, byteSize - contentBytes)) : null,
  };
}

export function displayPath(file: DiffFile): string {
  if (file.kind === "rename" || file.kind === "copy") {
    return `${file.oldPath} -> ${file.newPath}`;
  }
  if (file.kind === "delete") return file.oldPath;
  return file.newPath === "/dev/null" ? file.oldPath : file.newPath;
}

export function countChanges(hunks: readonly HunkData[]): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type === "insert") insertions += 1;
      if (change.type === "delete") deletions += 1;
    }
  }
  return { insertions, deletions };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function splitClipped(content: string): {
  head: string;
  tail: string | null;
  elidedBytes: number | null;
} {
  const match = ELISION_RE.exec(content);
  if (match?.index === undefined) {
    return { head: content, tail: null, elidedBytes: null };
  }
  return {
    head: content.slice(0, match.index),
    tail: content.slice(match.index + match[0].length),
    elidedBytes: Number(match[1]),
  };
}

function parseSegment(segment: string, afterClip: boolean): DiffFile[] {
  const parts = splitFilePatches(segment);
  return parts.map((part, index) => {
    const incomplete = afterClip && index === 0 && !part.startsWith("diff --git ");
    return incomplete ? parseIncomplete(part) : parseFilePatch(part, incomplete);
  });
}

function splitFilePatches(text: string): string[] {
  if (text.trim().length === 0) return [];
  return text.split(/(?=^diff --git )/m).filter((part) => part.trim().length > 0);
}

function parseFilePatch(raw: string, incomplete: boolean): DiffFile {
  const parsed = safeParse(raw)[0];
  const header = parseGitHeader(raw);
  const oldPath = presentPath(parsed?.oldPath) ?? renamePath(raw, "from") ?? header.oldPath;
  const newPath = presentPath(parsed?.newPath) ?? renamePath(raw, "to") ?? header.newPath;
  const oldMode = optionalMode(parsed?.oldMode) ?? matchMode(raw, OLD_MODE_RE);
  const newMode = optionalMode(parsed?.newMode) ?? matchMode(raw, NEW_MODE_RE);
  const hunks = parsed?.hunks ?? [];
  const { insertions, deletions } = countChanges(hunks);
  const kind = classify({ raw, parsed, oldPath, newPath, oldMode, newMode, hunks });

  return {
    kind,
    oldPath,
    newPath,
    oldMode,
    newMode,
    hunks,
    insertions,
    deletions,
    incomplete,
    similarity: parsed?.similarity ?? null,
  };
}

function parseIncomplete(raw: string): DiffFile {
  const recovered = recoverPath(raw);
  const parsed = raw.includes("@@") ? safeParse(syntheticPatch(raw, recovered))[0] : undefined;
  const hunks = parsed?.hunks ?? [];
  const { insertions, deletions } = countChanges(hunks);
  return {
    kind: parsed?.type === "add" ? "add" : parsed?.type === "delete" ? "delete" : "modify",
    oldPath: presentPath(parsed?.oldPath) ?? recovered,
    newPath: presentPath(parsed?.newPath) ?? recovered,
    oldMode: optionalMode(parsed?.oldMode),
    newMode: optionalMode(parsed?.newMode),
    hunks,
    insertions,
    deletions,
    incomplete: true,
    similarity: null,
  };
}

function classify(input: {
  raw: string;
  parsed: FileData | undefined;
  oldPath: string;
  newPath: string;
  oldMode: string | null;
  newMode: string | null;
  hunks: HunkData[];
}): DiffFileKind {
  if (isBinaryPatch(input.raw) || input.parsed?.isBinary === true) return "binary";
  if (input.parsed?.type === "add" || /^new file mode /m.test(input.raw)) return "add";
  if (input.parsed?.type === "delete" || /^deleted file mode /m.test(input.raw)) return "delete";
  if (input.parsed?.type === "copy" || /^copy (?:from|to) /m.test(input.raw)) return "copy";
  if (
    /^rename (?:from|to) /m.test(input.raw) ||
    (input.oldPath !== input.newPath &&
      input.oldPath !== "/dev/null" &&
      input.newPath !== "/dev/null")
  ) {
    return "rename";
  }
  if (
    input.hunks.length === 0 &&
    input.oldMode !== null &&
    input.newMode !== null &&
    input.oldMode !== input.newMode
  ) {
    return "mode";
  }
  return "modify";
}

function isBinaryPatch(raw: string): boolean {
  return /^GIT binary patch$/m.test(raw) || /^Binary files /m.test(raw);
}

function safeParse(raw: string): FileData[] {
  try {
    return parseDiff(raw);
  } catch {
    return [];
  }
}

function parseGitHeader(raw: string): { oldPath: string; newPath: string } {
  const first = raw.split("\n")[0] ?? "";
  const match = GIT_HEADER_RE.exec(first);
  if (!match) return { oldPath: "unknown", newPath: "unknown" };
  return {
    oldPath: match[1] ?? match[2] ?? "unknown",
    newPath: match[3] ?? match[4] ?? "unknown",
  };
}

function renamePath(raw: string, side: "from" | "to"): string | null {
  const match = (side === "from" ? RENAME_FROM_RE : RENAME_TO_RE).exec(raw);
  return match?.[1] ?? null;
}

function matchMode(raw: string, pattern: RegExp): string | null {
  return pattern.exec(raw)?.[1] ?? null;
}

function presentPath(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function optionalMode(value: string | undefined): string | null {
  return presentPath(value) ?? null;
}

function recoverPath(raw: string): string {
  const plus = /^\+\+\+ (?:b\/)?(.+)$/m.exec(raw);
  if (plus?.[1] && plus[1] !== "/dev/null") return plus[1];
  const minus = /^--- (?:a\/)?(.+)$/m.exec(raw);
  if (minus?.[1] && minus[1] !== "/dev/null") return minus[1];
  return "(truncated file)";
}

function syntheticPatch(raw: string, path: string): string {
  if (raw.startsWith("diff --git ")) return raw;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${raw}`;
}

export function changeKind(change: ChangeData): "added" | "removed" | "context" {
  if (change.type === "insert") return "added";
  if (change.type === "delete") return "removed";
  return "context";
}

export function changePrefix(change: ChangeData): string {
  if (change.type === "insert") return "+";
  if (change.type === "delete") return "-";
  return " ";
}

export function oldLineNumber(change: ChangeData): string {
  if (change.type === "insert") return "";
  if (change.type === "normal") return String(change.oldLineNumber);
  return String(change.lineNumber);
}

export function newLineNumber(change: ChangeData): string {
  if (change.type === "delete") return "";
  if (change.type === "normal") return String(change.newLineNumber);
  return String(change.lineNumber);
}
