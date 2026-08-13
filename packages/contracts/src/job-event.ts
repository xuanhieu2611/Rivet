import { z } from "zod";

import type { JobStatus } from "./job";

/**
 * The vocabulary of the append-only job event log.
 *
 * Unlike `JOB_STATUSES`, this list is NOT a Postgres enum. Status is a closed
 * state machine that is indexed and queried on, so it earns a real enum plus a
 * drift assertion. Event types are a growing description of what happened, read
 * back only to render a timeline, and the list churns every milestone - paying
 * a migration per new entry buys nothing. The column is `text` and this schema
 * is the validation.
 */
export const JOB_EVENT_TYPES = [
  "job.created",
  "job.enqueued",
  /**
   * The row committed but the message did not land.
   *
   * The one visible symptom of the dual-write gap between Postgres and Redis.
   * It is not a failure of the job - the sweeper re-enqueues orphaned `queued`
   * rows - but it is worth seeing on the timeline when it happens.
   */
  "job.enqueue_failed",
  "job.claimed",
  "job.status_changed",
  "phase.started",
  "phase.completed",
  "job.cancel_requested",
  "job.retry_scheduled",
  /** The sweeper took the job back from a worker that went silent. */
  "job.reclaimed",
  /** A worker discovered it no longer owns the job and stood down. */
  "job.lease_lost",
  "job.failed",
  "job.completed",

  // --- sandbox execution (M2) ------------------------------------------
  /** A container exists and the job now owns something that has to be destroyed. */
  "sandbox.created",
  "sandbox.destroyed",
  "repo.cloned",
  "deps.installed",
  /**
   * One command finished inside the sandbox.
   *
   * Carries `argv`, `exitCode`, `durationMs` and `commandId` and nothing else:
   * the transcript lives in `job_commands`, one join away, because the timeline
   * is read in full on every render and a `pnpm install` transcript is neither
   * small nor a fact.
   */
  "command.completed",
  /**
   * The repository's own test suite was run before anything was modified.
   *
   * A non-zero exit here is a recorded property of the repository, not a failed
   * job - see PRD §11 C.
   */
  "baseline.recorded",
] as const;

export const jobEventTypeSchema = z.enum(JOB_EVENT_TYPES);

export type JobEventType = z.infer<typeof jobEventTypeSchema>;

/**
 * Why a job ended badly, from PRD §23.
 *
 * Same reasoning as `JOB_EVENT_TYPES`: `text` in Postgres, validated here.
 * `cancelled` is present because a cancellation is recorded with a category
 * even though a cancelled job is not a failed job.
 */
export const FAILURE_CATEGORIES = [
  "worker_crash",
  "lease_expired",
  "timed_out",
  "budget_exceeded",
  "cancelled",

  // --- sandbox execution (M2) ------------------------------------------
  // Retryable and terminal are not a property of this list - `classify()` in
  // `packages/core/src/jobs/failure.ts` is what decides, through the error class
  // each one is carried by. The comments here record the reasoning so the two
  // cannot drift silently.
  /** The Docker daemon is not reachable. Retryable: the daemon may come back. */
  "sandbox_unavailable",
  /** Image pull or container create failed. Retryable. */
  "sandbox_create_failed",
  /** Clone failed: 404, auth required, no such branch. Terminal - a 404 does not improve on retry. */
  "repo_unavailable",
  /** No `package.json`, no recognisable lockfile. Terminal. */
  "unsupported_project",
  /**
   * The install command exited non-zero. Terminal.
   *
   * A judgment call: an install failure is sometimes a transient registry blip,
   * but just as often a lockfile that disagrees with its `package.json`, which
   * would fail identically three times while burning three attempts and three
   * containers.
   */
  "dependency_install_failed",
  /** One command blew its own timeout. Distinct from the job blowing `max_duration_seconds`. */
  "command_timed_out",
  /** The container hit its memory limit. Terminal, and told apart from a generic 137 by `State.OOMKilled`. */
  "oom_killed",
  /**
   * The reaper found a container whose job is no longer live.
   *
   * Not a job outcome - nothing ever writes this to `jobs.failure_category`. It
   * exists so the reaper's log line names the same taxonomy everything else does.
   */
  "sandbox_leaked",

  "unknown",
] as const;

export const failureCategorySchema = z.enum(FAILURE_CATEGORIES);

export type FailureCategory = z.infer<typeof failureCategorySchema>;

/**
 * Reads a `failure_category` column back into the enum.
 *
 * A value outside the list can only come from a newer version of Rivet writing
 * to the same database, so it degrades to `unknown` rather than to `null`:
 * "we do not recognise this failure" and "this did not fail" are different
 * facts and the UI renders them differently.
 */
export function parseFailureCategory(value: string | null | undefined): FailureCategory | null {
  if (value === null || value === undefined) return null;
  const parsed = failureCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

/**
 * The structured half of an event, stored in the `data` jsonb column.
 *
 * Written as a type alias rather than an interface on purpose: TypeScript gives
 * object type aliases an implicit index signature, which is what makes this
 * assignable to the loose `Record<string, unknown>` the Drizzle column is typed
 * as. The database package cannot import this type without making the
 * contracts -> database dependency circular.
 *
 * Every field is optional because different event types populate different
 * subsets: a status change carries `from`/`to`, a phase carries
 * `phase`/`durationMs`, a failure carries `error`/`failureCategory`.
 */
// The implicit index signature described above is exactly what an interface lacks.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type JobEventData = {
  /**
   * The status the job was actually in before the change.
   *
   * One concrete status, never the set of statuses a transition was willing to
   * accept - `transitionJob` reads it off the locked row for exactly this
   * reason. A timeline entry has to be a fact about this job.
   */
  from?: JobStatus;
  to?: JobStatus;
  phase?: string;
  durationMs?: number;
  /** `jobs.attempt_count` at the time, not BullMQ's per-message retry count. */
  attempt?: number;
  failureCategory?: FailureCategory;
  error?: string;
  /** The lease owner involved, for reclaim and fencing events. */
  leaseOwner?: string;

  // --- sandbox execution (M2) ------------------------------------------
  /** The container id, on `sandbox.created` / `sandbox.destroyed`. */
  containerId?: string;
  /** Null when the command was killed before it could exit. */
  exitCode?: number | null;
  /** Points at the `job_commands` row holding the transcript. */
  commandId?: number;
  /** The command as it was actually run. Never a shell string. */
  argv?: string[];
  /** The commit the clone resolved to, on `repo.cloned`. */
  commitSha?: string;
};

/** One row of the job timeline. */
export interface JobEvent {
  /**
   * Globally monotonic across all jobs. Ordering within a job is what it is
   * for; Milestone 3 also uses it as the SSE `Last-Event-ID` cursor.
   */
  id: number;
  jobId: string;
  type: JobEventType;
  message: string;
  data: JobEventData | null;
  createdAt: Date;
}
