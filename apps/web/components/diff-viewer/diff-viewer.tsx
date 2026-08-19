"use client";

import { useState } from "react";

import {
  changeKind,
  changePrefix,
  DIFF_FILE_COLLAPSE_THRESHOLD,
  displayPath,
  newLineNumber,
  oldLineNumber,
  parseDiffArtifact,
  type DiffFile,
  type DiffFileKind,
  type ParsedDiffArtifact,
} from "@/components/diff-viewer/parse-diff-artifact";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export { DIFF_FILE_COLLAPSE_THRESHOLD };

interface DiffViewerProps {
  content: string;
  truncated?: boolean;
  byteSize?: number;
}

/**
 * Client island that renders a stored unified diff.
 *
 * Parsing happens here rather than in the job page so `react-diff-view` never
 * enters a server component. Content still arrives the way the artifacts panel
 * already fetches it: the page reads the artifact, this island only presents it.
 */
export function DiffViewer({ content, truncated = false, byteSize }: DiffViewerProps) {
  const parsed = parseDiffArtifact({
    content,
    truncated,
    ...(byteSize === undefined ? {} : { byteSize }),
  });
  const collapsed = parsed.files.length > DIFF_FILE_COLLAPSE_THRESHOLD;

  return (
    <div className="space-y-3" aria-label="Code diff" role="region" data-diff-viewer="">
      {parsed.truncated ? <TruncationBanner parsed={parsed} /> : null}

      {parsed.entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">The recorded diff is empty.</p>
      ) : (
        <ol className="space-y-2">
          {parsed.entries.map((entry, index) =>
            entry.type === "clip" ? (
              <li key={`clip-${String(index)}`}>
                <ClipNotice elidedBytes={entry.elidedBytes} />
              </li>
            ) : (
              <li key={`${displayPath(entry.file)}-${String(index)}`}>
                <FileDiff file={entry.file} collapsed={collapsed} />
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function TruncationBanner({ parsed }: { parsed: ParsedDiffArtifact }) {
  const elided = parsed.elidedBytes ?? 0;
  return (
    <p
      className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
      data-diff-truncated=""
    >
      This diff was truncated. The original was {formatBytes(parsed.byteSize)}
      {elided > 0 ? `; ${formatBytes(elided)} in the middle were dropped` : ""}.
    </p>
  );
}

function ClipNotice({ elidedBytes }: { elidedBytes: number }) {
  return (
    <p
      className="rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-3 py-2 text-center font-mono text-xs text-amber-900 dark:text-amber-200"
      data-diff-clip=""
    >
      ... {String(elidedBytes)} bytes elided ...
    </p>
  );
}

function FileDiff({ file, collapsed }: { file: DiffFile; collapsed: boolean }) {
  const path = displayPath(file);
  const [open, setOpen] = useState(!collapsed);
  return (
    <details
      className="group overflow-hidden rounded-md border bg-background"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-diff-file={path}
      data-diff-kind={file.kind}
      data-diff-collapsed={collapsed ? "true" : "false"}
      data-diff-incomplete={file.incomplete ? "true" : "false"}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 flex-wrap items-baseline gap-2">
          <KindBadge kind={file.kind} />
          <code className="truncate font-mono text-xs">{path}</code>
          {file.oldMode && file.newMode && file.oldMode !== file.newMode ? (
            <span className="text-muted-foreground font-mono">
              {file.oldMode} -&gt; {file.newMode}
            </span>
          ) : null}
        </div>
        <div className="text-muted-foreground flex items-baseline gap-2 font-mono">
          {file.kind === "binary" || file.kind === "mode" ? null : (
            <>
              <span className="text-emerald-700 dark:text-emerald-300">
                +{String(file.insertions)}
              </span>
              <span className="text-red-700 dark:text-red-300">-{String(file.deletions)}</span>
            </>
          )}
          <span aria-hidden className="transition-transform group-open:rotate-180">
            ▾
          </span>
        </div>
      </summary>
      <div className="border-t">
        <FileBody file={file} />
      </div>
    </details>
  );
}

function FileBody({ file }: { file: DiffFile }) {
  if (file.kind === "binary") {
    return (
      <p className="text-muted-foreground px-3 py-2.5 text-xs" data-diff-binary="">
        Binary file changed
      </p>
    );
  }
  if (file.kind === "mode") {
    return (
      <p className="text-muted-foreground px-3 py-2.5 text-xs" data-diff-mode="">
        Mode changed
        {file.oldMode && file.newMode ? ` from ${file.oldMode} to ${file.newMode}` : ""}. There is
        no counterpart side.
      </p>
    );
  }
  if (file.incomplete && file.hunks.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-2.5 text-xs">
        This file was cut by truncation, so the remaining hunks cannot be parsed.
      </p>
    );
  }
  if (file.hunks.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-2.5 text-xs">No line changes in this file.</p>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-max min-w-full border-separate border-spacing-0 font-mono text-xs leading-5">
        <tbody>
          {file.hunks.map((hunk) => (
            <HunkRows key={hunk.content} hunk={hunk} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HunkRows({ hunk }: { hunk: DiffFile["hunks"][number] }) {
  return (
    <>
      <tr data-diff-line="hunk">
        <td colSpan={4} className="bg-sky-500/10 px-3 py-0.5 text-sky-800 dark:text-sky-200">
          {hunk.content}
        </td>
      </tr>
      {hunk.changes.map((change, index) => {
        const kind = changeKind(change);
        return (
          <tr key={`${hunk.content}-${String(index)}`} data-diff-line={kind}>
            <td className="text-muted-foreground w-10 px-2 text-right select-none">
              {oldLineNumber(change)}
            </td>
            <td className="text-muted-foreground w-10 px-2 text-right select-none">
              {newLineNumber(change)}
            </td>
            <td className={cn("w-4 px-1 text-center select-none", lineClassName(kind))}>
              {changePrefix(change)}
            </td>
            <td className={cn("min-w-[24rem] whitespace-pre px-2", lineClassName(kind))}>
              {change.content || " "}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function KindBadge({ kind }: { kind: DiffFileKind }) {
  return (
    <span
      className={cn(
        "rounded-sm px-1.5 py-0.5 font-medium tracking-wide uppercase",
        kindClassName(kind),
      )}
    >
      {kindLabel(kind)}
    </span>
  );
}

function kindLabel(kind: DiffFileKind): string {
  switch (kind) {
    case "add":
      return "added";
    case "delete":
      return "deleted";
    case "rename":
      return "renamed";
    case "copy":
      return "copied";
    case "binary":
      return "binary";
    case "mode":
      return "mode";
    case "modify":
      return "modified";
  }
}

function kindClassName(kind: DiffFileKind): string {
  switch (kind) {
    case "add":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
    case "delete":
      return "bg-red-500/15 text-red-800 dark:text-red-200";
    case "rename":
    case "copy":
      return "bg-sky-500/15 text-sky-800 dark:text-sky-200";
    case "binary":
      return "bg-amber-500/15 text-amber-900 dark:text-amber-200";
    case "mode":
      return "bg-muted text-muted-foreground";
    case "modify":
      return "bg-muted text-foreground";
  }
}

function lineClassName(kind: "added" | "removed" | "context" | "hunk"): string {
  switch (kind) {
    case "added":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
    case "removed":
      return "bg-red-500/15 text-red-800 dark:text-red-200";
    case "hunk":
      return "bg-sky-500/10 text-sky-800 dark:text-sky-200";
    case "context":
      return "text-muted-foreground";
  }
}
