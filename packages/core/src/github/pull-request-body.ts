import type { ImplementationPlan, ReviewReport, ValidationReport } from "@rivet/contracts";

/** A changed path and the line totals available to the PR body renderer. */
export interface PullRequestChangedFile {
  path: string;
  insertions: number | null;
  deletions: number | null;
}

/** The diff facts already persisted by validation. */
export interface PullRequestDiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  paths?: readonly string[];
  files?: readonly PullRequestChangedFile[];
}

export interface PullRequestBodyJob {
  id: string;
  title: string;
  description: string;
  issueUrl?: string | null;
}

/** Durable records used to compose the publication body without I/O. */
export interface PullRequestBodyInput {
  job: PullRequestBodyJob;
  plan: ImplementationPlan | null;
  implementationSummary: string | null;
  diffStat: PullRequestDiffStat | null;
  validationReport: ValidationReport | null;
  reviewReport: ReviewReport | null;
  /** Absolute or relative URL for the Rivet job detail page. */
  runUrl: string;
}

/**
 * Composes the body Rivet will publish, using only durable run outputs.
 *
 * The wording is intentionally ordinary Markdown rather than a second
 * structured contract. The durable sections and their source records are
 * stable, while prose in a pull request should remain useful to a human.
 */
export function composePullRequestBody(input: PullRequestBodyInput): string {
  const { job, plan, diffStat, validationReport, reviewReport } = input;
  const issueSummary = plan?.problemInterpretation ?? job.description;
  const rootCause = plan?.problemInterpretation ?? "No root cause was recorded by the planner.";
  const implementation = input.implementationSummary ?? "No implementation summary was recorded.";

  return [
    "## Issue summary",
    `**${job.title}**`,
    "",
    job.description,
    ...(job.issueUrl === undefined || job.issueUrl === null
      ? []
      : ["", `[View the original GitHub issue](${job.issueUrl})`]),
    "",
    "### Planner interpretation",
    issueSummary,
    "",
    "## Root cause",
    rootCause,
    "",
    "## Implementation summary",
    implementation,
    "",
    "## Files changed",
    renderFilesChanged(diffStat),
    "",
    "## Validation",
    renderValidation(validationReport),
    "",
    "## Known limitations",
    renderLimitations(plan, reviewReport),
    "",
    "---",
    `Rivet execution ID: \`${job.id}\``,
    `[View the Rivet run](${input.runUrl})`,
  ].join("\n");
}

function renderFilesChanged(stat: PullRequestDiffStat | null): string {
  if (!stat) return "No diff statistics were recorded.";

  const summary = `**${stat.filesChanged} file${stat.filesChanged === 1 ? "" : "s"} changed, +${stat.insertions}/-${stat.deletions}**`;
  const files =
    stat.files ?? stat.paths?.map((path) => ({ path, insertions: null, deletions: null }));
  if (!files || files.length === 0) return summary;

  return [
    summary,
    "",
    ...files.map(
      (file) =>
        `- \`${file.path}\` (${formatCount(file.insertions)}+/${formatCount(file.deletions)}-)`,
    ),
  ].join("\n");
}

function renderValidation(report: ValidationReport | null): string {
  if (!report || report.checks.length === 0) return "No structured validation report was recorded.";

  return [
    `Overall outcome: **${report.outcome}**`,
    ...report.checks.map((check) => {
      const details = check.tests
        ? ` (${check.tests.passed} passed, ${check.tests.failed} failed, ${check.tests.skipped} skipped)`
        : "";
      return `- **${check.kind}**: ${check.outcome}${details}`;
    }),
  ].join("\n");
}

function renderLimitations(
  plan: ImplementationPlan | null,
  reviewReport: ReviewReport | null,
): string {
  const limitations = plan?.riskAreas.map((risk) => `- ${risk}`) ?? [];
  const reviewFindings =
    reviewReport?.nonBlockingIssues.map((issue) => `- Review: ${issue.title}: ${issue.detail}`) ??
    [];

  if (limitations.length === 0 && reviewFindings.length === 0) return "None recorded.";
  return [...limitations, ...reviewFindings].join("\n");
}

function formatCount(value: number | null): string {
  return value === null ? "binary" : String(value);
}
