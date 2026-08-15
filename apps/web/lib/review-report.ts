import {
  parseSerializedReviewReport,
  REVIEW_ISSUE_CATEGORIES,
  type JobArtifact,
  type ReviewIssue,
  type ReviewIssueCategory,
  type ReviewReport,
} from "@rivet/contracts";

/** Reads the latest complete review report without allowing bad artifact data to break the page. */
export function readReviewReport(artifact: JobArtifact | null): ReviewReport | null {
  if (artifact?.type !== "review_report" || artifact.truncated) return null;

  try {
    return parseSerializedReviewReport(artifact.content);
  } catch {
    return null;
  }
}

export const REVIEW_ISSUE_CATEGORY_LABELS: Record<ReviewIssueCategory, string> = {
  correctness: "Correctness",
  incomplete: "Incomplete",
  concurrency: "Concurrency",
  security: "Security",
  edge_case: "Edge case",
  unnecessary_change: "Unnecessary change",
  weak_test: "Weak test",
  compatibility: "Compatibility",
};

export interface ReviewIssueGroup {
  category: ReviewIssueCategory;
  label: string;
  issues: ReviewIssue[];
}

/** Groups findings in the contract's stable category order for predictable rendering. */
export function groupReviewIssues(issues: readonly ReviewIssue[]): ReviewIssueGroup[] {
  const byCategory = new Map<ReviewIssueCategory, ReviewIssue[]>();

  for (const issue of issues) {
    const category = byCategory.get(issue.category);
    if (category) {
      category.push(issue);
    } else {
      byCategory.set(issue.category, [issue]);
    }
  }

  return REVIEW_ISSUE_CATEGORIES.flatMap((category) => {
    const categoryIssues = byCategory.get(category);
    return categoryIssues
      ? [{ category, label: REVIEW_ISSUE_CATEGORY_LABELS[category], issues: categoryIssues }]
      : [];
  });
}

export function formatReviewConfidence(confidence: number): string {
  return `${String(Math.round(confidence * 100))}%`;
}
