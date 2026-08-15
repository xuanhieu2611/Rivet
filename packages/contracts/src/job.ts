import type { JobStatus as DrizzleJobStatus } from "@rivet/database";
import { z } from "zod";

import type { FailureCategory } from "./job-event";
import { type ReviewDecision, type ReviewMode, reviewModeSchema } from "./review-report";

/**
 * The job lifecycle, mirroring the `job_status` Postgres enum.
 *
 * Kept in sync with `@rivet/database` by the type-level assertion at the bottom
 * of this file, so drift fails `pnpm typecheck` instead of production.
 */
export const JOB_STATUSES = [
  "queued",
  "provisioning",
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "revising",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
  "budget_exceeded",
  "timed_out",
] as const;

export const jobStatusSchema = z.enum(JOB_STATUSES);

export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Statuses from which a job never transitions again - the live stream closes here. */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "completed",
  "failed",
  "cancelled",
  "budget_exceeded",
  "timed_out",
]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Request body for `POST /api/jobs`.
 *
 * Field names are camelCase to match the Drizzle row shape, so the service layer
 * can pass the parsed value through without remapping.
 */
export const createJobSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(200, "Title must be 200 characters or fewer"),
  description: z
    .string()
    .trim()
    .min(1, "Description is required")
    .max(10_000, "Description must be 10000 characters or fewer"),
  repoUrl: z
    .url({ protocol: /^https$/, error: "Must be an https:// repository URL" })
    .max(2048, "Repository URL is too long"),
  baseBranch: z.string().trim().min(1).max(255).default("main"),
  /**
   * Whether this run gets an independent review session.
   *
   * A property of the job rather than a deployment switch, so a job that
   * recorded `independent` is reviewed whichever worker picks it up. `none`
   * runs the M7 workflow and says so on the timeline.
   */
  reviewMode: reviewModeSchema.default("independent"),
  /**
   * How many revisions this job may spend before a blocking verdict fails it.
   *
   * Bounded rather than open-ended because the loop multiplies cost, and zero
   * is legal: it means one review whose `revise` verdict has no budget behind
   * it.
   */
  maxReviewLoops: z
    .number()
    .int("Maximum review loops must be a whole number")
    .min(0, "Maximum review loops must be 0 or more")
    .max(5, "Maximum review loops must be 5 or fewer")
    .default(2),
});

/** What a client sends - `baseBranch` may be omitted. */
export type CreateJobInput = z.input<typeof createJobSchema>;
/** What the server works with after parsing - every field is present. */
export type CreateJob = z.output<typeof createJobSchema>;

/**
 * A row in the dashboard list.
 *
 * Timestamps are `Date` because M0 renders through server components that read
 * the Drizzle row directly; the route handlers serialise them to ISO strings.
 */
export interface JobSummary {
  id: string;
  title: string;
  repoUrl: string;
  baseBranch: string;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The full job detail page payload.
 *
 * The execution columns below are deliberately NOT on `JobSummary`. The
 * dashboard does not render them, and keeping the list payload narrow matters
 * more once there are hundreds of jobs.
 */
export interface JobDetail extends JobSummary {
  description: string;
  baseCommitSha: string | null;
  /** The environment recorded by provisioning, for reproducibility. */
  envFingerprint: Record<string, unknown> | null;
  priority: number;
  maxDurationSeconds: number;
  maxCostUsd: string;
  maxModelCalls: number;
  maxToolCalls: number;
  /** Cumulative input tokens reported by coding-agent sessions. */
  totalInputTokens: number;
  /** Cumulative output tokens reported by coding-agent sessions. */
  totalOutputTokens: number;
  /** Cumulative priced usage, as a decimal string from Postgres numeric. */
  totalCostUsd: string;
  /** Cumulative completed model turns across planner and implementation sessions. */
  totalTurns: number;
  /** Cumulative model calls across every session and every attempt. */
  totalModelCalls: number;
  /** Cumulative tool calls across every session and every attempt. */
  totalToolCalls: number;
  startedAt: Date | null;
  /**
   * When this job's wall-clock budget runs out, set on the first claim.
   *
   * Retained across every reclaim, which is the whole point: a crash does not
   * hand the replacement worker another `maxDurationSeconds`, and the time the
   * job spent waiting for one counts against it. Null until the first claim.
   */
  deadlineAt: Date | null;
  completedAt: Date | null;
  finalBranch: string | null;
  pullRequestUrl: string | null;
  failureReason: string | null;

  /** The durable delivery generation carried by the queue message. */
  dispatchGeneration: number;
  /** How many times any worker has claimed this job, reclaims included. */
  attemptCount: number;
  /** Machine-readable cause, paired with the human-readable `failureReason`. */
  failureCategory: FailureCategory | null;
  /** Non-null once a cancel has been asked for, before the worker acts on it. */
  cancelRequestedAt: Date | null;
  /** When the current worker's ownership lapses. Null when nothing holds it. */
  leaseExpiresAt: Date | null;

  /** Whether this job gets an independent review session at all. */
  reviewMode: ReviewMode;
  /** Revisions this job may spend before a blocking verdict fails it. */
  maxReviewLoops: number;
  /** Revisions already spent. Survives a reclaim, like every other budget. */
  reviewLoops: number;
  /** The last verdict, null until a reviewer has answered. */
  reviewDecision: ReviewDecision | null;
  /** Blocking findings in that last verdict, null until one exists. */
  reviewBlockingCount: number | null;
}

/**
 * Drift guard between the Zod enum above and the `job_status` pgEnum.
 *
 * `@rivet/database` is a devDependency and this is a type-only import, erased at
 * compile time under `verbatimModuleSyntax`, so `pg` can never reach a browser
 * bundle through this package. Both directions are asserted: adding a value to
 * either enum alone is a type error.
 */
type AssertAssignable<Subject extends Target, Target> = Subject;

type _ZodStatusesExistInDatabase = AssertAssignable<JobStatus, DrizzleJobStatus>;
type _DatabaseStatusesExistInZod = AssertAssignable<DrizzleJobStatus, JobStatus>;
