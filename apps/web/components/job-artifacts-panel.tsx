import type { ArtifactType, JobArtifact, JobArtifactSummary } from "@rivet/contracts";

import { DiffViewer } from "@/components/diff-viewer/diff-viewer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatDateTime } from "@/lib/format";

const ARTIFACT_LABELS: Record<ArtifactType, string> = {
  diff: "Working tree diff",
  diff_stat: "Diff stats",
  implementation_summary: "Implementation summary",
  implementation_plan: "Implementation plan",
  baseline_report: "Baseline report",
  validation_report: "Validation report",
  review_report: "Review report",
  resource_report: "Sandbox resource report",
  pull_request_body: "Pull request body",
};

interface JobArtifactsPanelProps {
  artifacts: readonly JobArtifactSummary[];
  summary: JobArtifact | null;
  diff: JobArtifact | null;
}

/**
 * Server-rendered durable outputs for a job.
 *
 * The live event stream only carries artifact metadata. Content is read by the
 * page after the stream has settled, so a large diff never becomes part of the
 * timeline payload or the browser's live reducer.
 */
export function JobArtifactsPanel({ artifacts, summary, diff }: JobArtifactsPanelProps) {
  const diffStat = latestArtifactOfType(artifacts, "diff_stat");
  const stats = diffStat ? readDiffStats(diffStat.metadata) : null;

  return (
    <Card id="artifacts">
      <CardHeader>
        <CardTitle>Artifacts</CardTitle>
        <CardDescription>
          Durable outputs from validation, review and finalization. Content is read after the run
          rather than streamed with the timeline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {artifacts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No durable artifacts have been recorded yet.
          </p>
        ) : (
          <ArtifactIndex artifacts={artifacts} />
        )}

        {summary ? (
          <ArtifactSection
            title="Implementation summary"
            artifact={summary}
            description="The last non-empty message from the implementation session."
          >
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
              {summary.content}
            </p>
          </ArtifactSection>
        ) : null}

        {diff ? (
          <ArtifactSection
            title="Working tree diff"
            artifact={diff}
            description={
              stats ? formatDiffStats(stats) : "The staged change captured by validation."
            }
          >
            <DiffViewer
              content={diff.content}
              truncated={diff.truncated}
              byteSize={diff.byteSize}
            />
          </ArtifactSection>
        ) : null}

        {artifacts.length > 0 && !summary && !diff ? (
          <p className="text-muted-foreground text-sm">
            The recorded artifacts do not have a displayable summary or diff.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ArtifactIndex({ artifacts }: { artifacts: readonly JobArtifactSummary[] }) {
  return (
    <section className="space-y-2" aria-label="Recorded artifacts">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        Recorded outputs
      </h3>
      <ol className="divide-border/60 divide-y rounded-lg border">
        {artifacts.map((artifact) => (
          <li
            key={artifact.id}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2.5 text-xs"
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="font-medium">{ARTIFACT_LABELS[artifact.type]}</span>
              <span className="text-muted-foreground font-mono">#{String(artifact.id)}</span>
            </div>
            <div className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span>{formatBytes(artifact.byteSize)}</span>
              <span aria-hidden>·</span>
              <span>{formatDateTime(artifact.createdAt)}</span>
              {artifact.truncated ? (
                <span className="text-amber-700 dark:text-amber-300">truncated</span>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ArtifactSection({
  title,
  description,
  artifact,
  children,
}: {
  title: string;
  description: string;
  artifact: JobArtifact;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border/70 overflow-hidden rounded-lg border">
      <div className="border-border/60 flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/20 px-3 py-2.5">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
        </div>
        <ArtifactMeta artifact={artifact} />
      </div>
      <div className="min-w-0 p-3">{children}</div>
    </section>
  );
}

function ArtifactMeta({ artifact }: { artifact: JobArtifact }) {
  return (
    <div className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span>{formatBytes(artifact.byteSize)}</span>
      {artifact.truncated ? (
        <span className="text-amber-700 dark:text-amber-300">truncated</span>
      ) : null}
    </div>
  );
}

function latestArtifactOfType(
  artifacts: readonly JobArtifactSummary[],
  type: ArtifactType,
): JobArtifactSummary | null {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (artifact?.type === type) return artifact;
  }
  return null;
}

interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

function readDiffStats(metadata: Record<string, unknown> | null): DiffStats | null {
  if (!metadata) return null;
  const filesChanged = nonNegativeInteger(metadata.filesChanged);
  const insertions = nonNegativeInteger(metadata.insertions);
  const deletions = nonNegativeInteger(metadata.deletions);
  if (filesChanged === null || insertions === null || deletions === null) return null;
  return { filesChanged, insertions, deletions };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function formatDiffStats(stats: DiffStats): string {
  return `${plural(stats.filesChanged, "file")} changed, +${String(stats.insertions)}/-${String(stats.deletions)}`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}
