import type { JobArtifactSummary } from "@rivet/contracts";

/**
 * The `diff_stat` artifact's metadata, in the shape validation records it.
 *
 * Read defensively rather than parsed with Zod: this is presentation, and an
 * artifact whose metadata has drifted should cost the reader a line of text
 * rather than the page.
 */
export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export function readDiffStats(metadata: Record<string, unknown> | null): DiffStats | null {
  if (!metadata) return null;
  const filesChanged = nonNegativeInteger(metadata.filesChanged);
  const insertions = nonNegativeInteger(metadata.insertions);
  const deletions = nonNegativeInteger(metadata.deletions);
  if (filesChanged === null || insertions === null || deletions === null) return null;
  return { filesChanged, insertions, deletions };
}

/** The newest `diff_stat` artifact's stats, or null when there is no readable one. */
export function latestDiffStats(artifacts: readonly JobArtifactSummary[]): DiffStats | null {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (artifact?.type === "diff_stat") return readDiffStats(artifact.metadata);
  }
  return null;
}

/** `3 files changed, +48/-12`. */
export function formatDiffStats(stats: DiffStats): string {
  return `${plural(stats.filesChanged, "file")} changed, +${String(stats.insertions)}/-${String(stats.deletions)}`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
