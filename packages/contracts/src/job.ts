import type { JobStatus as DrizzleJobStatus } from "@rivet/database";
import { z } from "zod";

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

/** Statuses from which a job never transitions again - the UI stops polling here. */
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

/** The full job detail page payload. */
export interface JobDetail extends JobSummary {
  description: string;
  baseCommitSha: string | null;
  priority: number;
  maxDurationSeconds: number;
  maxCostUsd: string;
  maxModelCalls: number;
  maxToolCalls: number;
  startedAt: Date | null;
  completedAt: Date | null;
  finalBranch: string | null;
  pullRequestUrl: string | null;
  failureReason: string | null;
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
