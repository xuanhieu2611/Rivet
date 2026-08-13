import {
  type CreateJob,
  type JobDetail,
  type JobSummary,
  parseFailureCategory,
} from "@rivet/contracts";
import { db, type Database, type Job, jobs } from "@rivet/database";
import { desc, eq } from "drizzle-orm";

import { appendEvent } from "../events/event-service";

/**
 * All of Rivet's job business logic, in one framework-agnostic module.
 *
 * There is deliberately NO Next.js import in this file - not `server-only`, not
 * `next/cache`, nothing. It takes plain arguments and returns plain data, which
 * is what let it move out of `apps/web` into this package intact once the
 * Milestone 1 worker became a second consumer of the same logic. The
 * `server-only` guard belongs in the route handlers and pages that wrap it,
 * which is where it is.
 */

export const DEFAULT_JOB_LIST_LIMIT = 50;
export const MAX_JOB_LIST_LIMIT = 200;

/** Matches the `uuid` shape Postgres will accept for `jobs.id`. */
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` could be a job id.
 *
 * Postgres raises `invalid input syntax for type uuid` for anything else, which
 * would surface as a 500. Callers check first and return a 404 instead.
 */
export function isJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
}

/**
 * Clamps a caller-supplied list limit into `[1, MAX_JOB_LIST_LIMIT]`.
 *
 * Accepts the raw query-string value so the route handler stays a pass-through.
 * Junk and out-of-range values are clamped rather than rejected - a dashboard
 * list is not worth a 400.
 */
export function resolveListLimit(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_JOB_LIST_LIMIT;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_JOB_LIST_LIMIT;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_JOB_LIST_LIMIT);
}

/** Narrows a database row to the fields the dashboard list renders. */
export function toJobSummary(row: Job): JobSummary {
  return {
    id: row.id,
    title: row.title,
    repoUrl: row.repoUrl,
    baseBranch: row.baseBranch,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Maps a database row to the detail-page payload. */
export function toJobDetail(row: Job): JobDetail {
  return {
    ...toJobSummary(row),
    description: row.description,
    baseCommitSha: row.baseCommitSha,
    envFingerprint: row.envFingerprint,
    priority: row.priority,
    maxDurationSeconds: row.maxDurationSeconds,
    maxCostUsd: row.maxCostUsd,
    maxModelCalls: row.maxModelCalls,
    maxToolCalls: row.maxToolCalls,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    finalBranch: row.finalBranch,
    pullRequestUrl: row.pullRequestUrl,
    failureReason: row.failureReason,
    attemptCount: row.attemptCount,
    // `failure_category` is a plain text column, so a value written by a newer
    // build could be outside the enum. Coerced rather than trusted.
    failureCategory: parseFailureCategory(row.failureCategory),
    cancelRequestedAt: row.cancelRequestedAt,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

/**
 * Persists a new job and opens its timeline.
 *
 * The `job.created` event is written in the same transaction as the row, so the
 * history a job carries starts at the same instant the job does. Enqueueing is
 * deliberately NOT part of this: it cannot join the transaction, and pretending
 * otherwise would hide the dual-write gap that `requestJobRun` documents.
 *
 * The column defaults supply status, priority and every budget value.
 */
export async function createJob(input: CreateJob, database: Database = db): Promise<JobDetail> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .insert(jobs)
      .values({
        title: input.title,
        description: input.description,
        repoUrl: input.repoUrl,
        baseBranch: input.baseBranch,
      })
      .returning();

    if (!row) {
      throw new Error("Insert into jobs returned no row.");
    }

    await appendEvent(
      { jobId: row.id, type: "job.created", message: `Job created: ${row.title}` },
      tx,
    );

    return toJobDetail(row);
  });
}

/** Newest jobs first, capped at `MAX_JOB_LIST_LIMIT`. */
export async function listJobs(options: { limit?: number } = {}): Promise<JobSummary[]> {
  const rows = await db
    .select()
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(resolveListLimit(options.limit));

  return rows.map(toJobSummary);
}

/** A single job, or `null` when the id is absent or not a uuid. */
export async function getJob(id: string): Promise<JobDetail | null> {
  if (!isJobId(id)) return null;

  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ? toJobDetail(row) : null;
}
