import { z } from "zod";

/**
 * Whether a job runs an independent review session at all.
 *
 * A property of the job rather than of the worker, which is why it is here and
 * settable on `createJobSchema`: a job that recorded `independent` is reviewed
 * whichever worker picks it up, exactly as `max_cost_usd` is honoured whichever
 * worker picks it up.
 */
export const REVIEW_MODES = ["independent", "none"] as const;

export const reviewModeSchema = z.enum(REVIEW_MODES);

export type ReviewMode = z.infer<typeof reviewModeSchema>;

/** The reviewer's verdict on the patch it was handed. */
export const REVIEW_DECISIONS = ["approve", "revise"] as const;

export const reviewDecisionSchema = z.enum(REVIEW_DECISIONS);

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

/**
 * Coerces the `jobs.review_mode` text column into the closed vocabulary.
 *
 * Same reasoning as `parseFailureCategory`: the column is plain text, so a value
 * written by a newer build could be outside the enum. The column is defaulted
 * and never null, and `independent` is that default, so an unreadable value
 * degrades into "this job is reviewed" rather than into "this job is not".
 */
export function parseReviewMode(value: string | null | undefined): ReviewMode {
  const parsed = reviewModeSchema.safeParse(value);
  return parsed.success ? parsed.data : "independent";
}

/**
 * Coerces the nullable `jobs.review_decision` text column.
 *
 * Null means no reviewer has answered yet, which is a different fact from a
 * verdict this build cannot read; both come back as `null` because there is no
 * honest third value, and the durable `review_report` artifact is what a reader
 * consults when the column disagrees with it.
 */
export function parseReviewDecision(value: string | null | undefined): ReviewDecision | null {
  if (value === null || value === undefined) return null;
  const parsed = reviewDecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * PRD §6.8's "what the reviewer should look for" list, turned into a closed
 * vocabulary.
 *
 * Closed rather than free text so the detail page can group findings and so
 * anything later can count them by kind instead of grepping prose.
 */
export const REVIEW_ISSUE_CATEGORIES = [
  "correctness",
  "incomplete",
  "concurrency",
  "security",
  "edge_case",
  "unnecessary_change",
  "weak_test",
  "compatibility",
] as const;

export const reviewIssueCategorySchema = z.enum(REVIEW_ISSUE_CATEGORIES);

export type ReviewIssueCategory = z.infer<typeof reviewIssueCategorySchema>;

/**
 * Bounds for the structured verdict that crosses the agent and persistence
 * boundaries, kept independent of the artifact store's byte limit for the same
 * reason `IMPLEMENTATION_PLAN_LIMITS` is: the report has to stay useful as a
 * structured value, not merely fit in a column.
 */
export const REVIEW_REPORT_LIMITS = {
  titleMaxChars: 200,
  detailMaxChars: 4_000,
  summaryMaxChars: 4_000,
  maxPathsPerIssue: 20,
  maxIssuesPerList: 20,
} as const;

/**
 * One finding. Strict, like the plan schema: silently accepting another field
 * would make the persisted shape depend on whichever model or adapter produced
 * it.
 */
export const reviewIssueSchema = z
  .object({
    title: z.string().trim().min(1).max(REVIEW_REPORT_LIMITS.titleMaxChars),
    detail: z.string().trim().min(1).max(REVIEW_REPORT_LIMITS.detailMaxChars),
    /** Repository-relative paths this finding is about. May be empty. */
    paths: z.array(z.string().trim().min(1)).max(REVIEW_REPORT_LIMITS.maxPathsPerIssue).default([]),
    category: reviewIssueCategorySchema,
  })
  .strict();

export type ReviewIssue = z.infer<typeof reviewIssueSchema>;

/**
 * The reviewer's whole durable output.
 *
 * The cross-field rule lives in the schema rather than in the phase, so the
 * model gets a tool error it can correct on its next turn instead of the phase
 * discovering the contradiction after the session has ended. A verdict that
 * says revise and names nothing to fix cannot be acted on, and one that
 * approves while listing blockers is self-contradictory.
 */
export const reviewReportSchema = z
  .object({
    decision: reviewDecisionSchema,
    blockingIssues: z.array(reviewIssueSchema).max(REVIEW_REPORT_LIMITS.maxIssuesPerList),
    nonBlockingIssues: z.array(reviewIssueSchema).max(REVIEW_REPORT_LIMITS.maxIssuesPerList),
    confidence: z.number().min(0).max(1),
    summary: z.string().trim().min(1).max(REVIEW_REPORT_LIMITS.summaryMaxChars),
  })
  .strict()
  .refine(
    (report) => report.decision !== "revise" || report.blockingIssues.length > 0,
    "A decision of 'revise' requires at least one blocking issue.",
  )
  .refine(
    (report) => report.decision !== "approve" || report.blockingIssues.length === 0,
    "A decision of 'approve' requires no blocking issues.",
  );

export type ReviewReport = z.infer<typeof reviewReportSchema>;

function normalizeReviewIssue(issue: ReviewIssue): ReviewIssue {
  return {
    title: issue.title,
    detail: issue.detail,
    paths: [...issue.paths],
    category: issue.category,
  };
}

function normalizeReviewReport(value: unknown): ReviewReport {
  const parsed = reviewReportSchema.parse(value);

  // Construct the object in schema order. JSON.stringify then has one canonical
  // representation regardless of the order supplied by the caller.
  return {
    decision: parsed.decision,
    blockingIssues: parsed.blockingIssues.map(normalizeReviewIssue),
    nonBlockingIssues: parsed.nonBlockingIssues.map(normalizeReviewIssue),
    confidence: parsed.confidence,
    summary: parsed.summary,
  };
}

/** Validates and normalizes a review report before it crosses a boundary. */
export function parseReviewReport(value: unknown): ReviewReport {
  return normalizeReviewReport(value);
}

/** Serializes a validated review report into its canonical JSON representation. */
export function serializeReviewReport(value: unknown): string {
  return JSON.stringify(normalizeReviewReport(value));
}

/** Alias named after the property this function guarantees. */
export const canonicalizeReviewReport = serializeReviewReport;

/** Parses canonical JSON or any JSON string containing a valid review report. */
export function parseSerializedReviewReport(value: unknown): ReviewReport {
  if (typeof value !== "string") {
    throw new Error("Invalid review report JSON: expected a string.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid review report JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return normalizeReviewReport(parsed);
}
