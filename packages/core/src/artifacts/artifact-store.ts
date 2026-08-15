import {
  parseSerializedImplementationPlan,
  type ArtifactType,
  type ImplementationPlan,
  type JobArtifact,
  type JobArtifactSummary,
  type JobStatus,
} from "@rivet/contracts";
import { db, type Executor, type JobArtifactRow, jobArtifacts } from "@rivet/database";
import { and, asc, desc, eq, gt } from "drizzle-orm";

import { assertActiveLease } from "../jobs/lease";
import { truncate } from "../sandbox/command-log";

/**
 * The append-only store of a job's durable output.
 *
 * The same two rules as `events/event-service.ts` and `sandbox/command-log.ts`,
 * for the same reason: nothing here ever updates or deletes a row, and every
 * function takes an `Executor` so an artifact can be written inside the
 * transaction that records what it meant. This is the only writer of
 * `job_artifacts`.
 *
 * PRD §8 wants object storage eventually and PRD §10.8 gives `Artifact` a
 * `storage_url`. When that arrives it replaces the body of `recordArtifact` and
 * `getArtifact` behind the same two signatures, which is the whole reason
 * phases reach it through `PhaseContext.artifact()` rather than importing it.
 */

/** What a list query returns when the caller does not say. Diffs are few and large. */
export const DEFAULT_ARTIFACT_LIMIT = 100;

export interface RecordArtifactInput {
  jobId: string;
  type: ArtifactType;
  /** The status the job was in when the artifact was produced. */
  phase: JobStatus;
  content: string;
  /**
   * The cap on stored content, which this function applies itself.
   *
   * Required rather than defaulted, and applied here rather than by the caller,
   * because the failure mode of a forgotten bound is a 4MB diff in a `text`
   * column that some later page render pulls in full. A caller that has already
   * bounded its own string loses nothing by passing the cap again; a caller
   * that forgot is the case this exists for.
   */
  maxBytes: number;
  metadata?: Record<string, unknown>;
  /** When true, reject content above the bound instead of truncating it. */
  requireComplete?: boolean;
  /** When present, the artifact row is fenced on this active lease. */
  leaseOwner?: string;
}

/**
 * Writes one artifact, bounding its content on the way in.
 *
 * `byteSize` is the size of what came in, not of what was stored, and the two
 * disagreeing is the entire point of keeping the column: a 4MB diff kept as
 * 256KB is a fact a reader should be able to read off the row without fetching
 * either version. The elision itself is the same head+tail marker a command
 * transcript gets, so the gap in the middle is visibly Rivet's and states its
 * own size.
 */
export async function recordArtifact(
  input: RecordArtifactInput,
  executor: Executor = db,
): Promise<JobArtifact> {
  // Keep the lease check and insert in one transaction when this writer is
  // called directly. PhaseContext already supplies a transaction for the
  // artifact row and its `artifact.recorded` event.
  if (input.leaseOwner !== undefined && executor === db) {
    return db.transaction((tx) => recordArtifact(input, tx));
  }
  if (input.leaseOwner !== undefined) {
    await assertActiveLease(input.jobId, input.leaseOwner, executor);
  }

  const byteSize = Buffer.byteLength(input.content, "utf8");
  if (input.requireComplete && byteSize > input.maxBytes) {
    throw new ArtifactTooLargeError(
      `The ${input.type} artifact is ${byteSize} bytes, above the complete ${input.maxBytes}-byte limit.`,
    );
  }
  const bounded = truncate(input.content, input.maxBytes);

  const [row] = await executor
    .insert(jobArtifacts)
    .values({
      jobId: input.jobId,
      type: input.type,
      phase: input.phase,
      content: bounded.text,
      byteSize,
      truncated: bounded.truncated,
      // `exactOptionalPropertyTypes` is on, so absent metadata has to be an
      // absent key rather than an explicit `undefined`.
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
    .returning();

  if (!row) {
    throw new Error("Insert into job_artifacts returned no row.");
  }
  return toJobArtifact(row);
}

/** A complete structured plan recovered from the append-only artifact store. */
export interface StoredImplementationPlan {
  artifactId: number;
  plan: ImplementationPlan;
}

/**
 * Reads the newest content for one artifact type.
 *
 * Review context is assembled from durable outputs rather than from values a
 * previous phase happened to keep in memory. Unlike structured report readers,
 * this helper deliberately returns truncated content too: a diff or a summary
 * is still useful with an explicit storage-bound marker, while callers that
 * need complete JSON use their type-specific reader instead.
 */
export async function readLatestArtifactContent(
  jobId: string,
  type: ArtifactType,
  executor: Executor = db,
): Promise<string | null> {
  const [row] = await executor
    .select({ content: jobArtifacts.content })
    .from(jobArtifacts)
    .where(and(eq(jobArtifacts.jobId, jobId), eq(jobArtifacts.type, type)))
    .orderBy(desc(jobArtifacts.id))
    .limit(1);

  return row?.content ?? null;
}

/** The writer refuses a complete artifact rather than silently clipping it. */
export class ArtifactTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactTooLargeError";
  }
}

/**
 * Finds the newest complete, parseable implementation plan.
 *
 * A newer malformed row does not make an older valid plan disappear from the
 * recovery context. The artifact itself remains visible for diagnosis, while
 * callers receive the latest value that can actually be trusted.
 */
export async function readLatestImplementationPlan(
  jobId: string,
  executor: Executor = db,
): Promise<StoredImplementationPlan | null> {
  const rows = await executor
    .select({
      id: jobArtifacts.id,
      content: jobArtifacts.content,
      truncated: jobArtifacts.truncated,
    })
    .from(jobArtifacts)
    .where(and(eq(jobArtifacts.jobId, jobId), eq(jobArtifacts.type, "implementation_plan")))
    .orderBy(desc(jobArtifacts.id));

  for (const row of rows) {
    if (row.truncated) continue;
    try {
      return { artifactId: row.id, plan: parseSerializedImplementationPlan(row.content) };
    } catch {
      // The next older plan is still a valid recovery input if this row was
      // written by an interrupted or newer producer.
    }
  }

  return null;
}

export interface ListArtifactsOptions {
  /** Return only artifacts with an id greater than this cursor. */
  after?: number;
  limit?: number;
}

/**
 * One job's artifacts in the order they were produced, without their content.
 *
 * Without the content deliberately: this is what the detail page and
 * `GET /api/jobs/:id/artifacts` read, and a diff belongs one fetch away rather
 * than in every render of the timeline that happens to sit above it.
 */
export async function listArtifacts(
  jobId: string,
  options: ListArtifactsOptions = {},
  executor: Executor = db,
): Promise<JobArtifactSummary[]> {
  const rows = await executor
    .select(artifactSummaryColumns)
    .from(jobArtifacts)
    .where(
      and(
        eq(jobArtifacts.jobId, jobId),
        options.after === undefined ? undefined : gt(jobArtifacts.id, options.after),
      ),
    )
    // Ascending by id, which is also chronological: one lease holder is the
    // only writer for a given job, so ids cannot arrive out of order.
    .orderBy(asc(jobArtifacts.id))
    .limit(options.limit ?? DEFAULT_ARTIFACT_LIMIT);

  return rows.map(toJobArtifactSummary);
}

/**
 * One artifact and its content, or null when it is not part of the job.
 *
 * Scoped by `jobId` rather than looked up by id alone, exactly as `getCommand`
 * is: the id is globally monotonic, so an unscoped fetch would let one job's
 * URL read another job's diff.
 */
export async function getArtifact(
  jobId: string,
  artifactId: number,
  executor: Executor = db,
): Promise<JobArtifact | null> {
  if (!Number.isSafeInteger(artifactId) || artifactId < 1) return null;

  const [row] = await executor
    .select()
    .from(jobArtifacts)
    .where(and(eq(jobArtifacts.jobId, jobId), eq(jobArtifacts.id, artifactId)))
    .limit(1);

  return row ? toJobArtifact(row) : null;
}

type JobArtifactSummaryRow = Omit<JobArtifactRow, "content">;

const artifactSummaryColumns = {
  id: jobArtifacts.id,
  jobId: jobArtifacts.jobId,
  type: jobArtifacts.type,
  phase: jobArtifacts.phase,
  byteSize: jobArtifacts.byteSize,
  truncated: jobArtifacts.truncated,
  metadata: jobArtifacts.metadata,
  createdAt: jobArtifacts.createdAt,
};

/** Maps a database row to the contract shape. */
export function toJobArtifact(row: JobArtifactRow): JobArtifact {
  return { ...toJobArtifactSummary(row), content: row.content };
}

/** The same, without the content, for list queries. */
export function toJobArtifactSummary(row: JobArtifactSummaryRow): JobArtifactSummary {
  return {
    id: row.id,
    jobId: row.jobId,
    // `type` and `phase` are both `text` rather than enums - see the schema -
    // and this process is their only writer, so an unrecognised value could
    // only come from a newer build of Rivet.
    type: row.type as ArtifactType,
    phase: row.phase as JobStatus,
    byteSize: row.byteSize,
    truncated: row.truncated,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
  };
}
