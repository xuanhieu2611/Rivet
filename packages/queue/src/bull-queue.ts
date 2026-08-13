import type { EnqueueOptions, EnqueueResult, JobQueue } from "@rivet/core";
import { type JobsOptions, Queue } from "bullmq";

import { getRedis } from "./connection";
import {
  JOB_NAMES,
  type JobRunsMessage,
  QUEUE_NAMES,
  SCHEDULER_IDS,
  type SweepPayload,
} from "./names";

/**
 * The BullMQ adapter for the `JobQueue` port.
 *
 * Everything Redis-specific in Rivet lives behind this class. It is deliberately
 * boring: the message is a job id, the BullMQ job id is the same job id, and the
 * interesting decisions are all about idempotency.
 *
 * Version note: this is BullMQ **6**, released 2026-07-30. Most material online
 * describes v5, where the legacy repeatable-jobs API still existed, `job.discard()`
 * was how you refused a retry, and `Queue#client` was public. All three are gone.
 * `ioredis` is also an optional peer dependency now rather than a direct one,
 * which is why this package depends on it explicitly.
 */

/**
 * Defaults applied to every `run-job` message.
 *
 * `removeOnComplete` is the one that took thought. A completed BullMQ job keeps
 * its id reserved, and Rivet reuses the Postgres job UUID as the BullMQ job id
 * on purpose. Keeping a debugging window of completed messages would therefore
 * make a later re-enqueue of the same job - a retry, or a sweeper reclaim -
 * silently deduplicate against a message that already ran. `enqueueJobRun`
 * handles that explicitly below, but a short retention keeps the failure mode
 * small even if someone bypasses it. Redis is not the audit log; `job_events`
 * in Postgres is.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 300, count: 50 },
  removeOnFail: { age: 3_600, count: 200 },
};

/** States in which a message is finished and its id may be reused. */
const FINISHED_STATES = new Set(["completed", "failed", "unknown"]);

/**
 * Options for the recurring sweep messages.
 *
 * A sweep is pure reconciliation: everything it needs is in Postgres, and the
 * next one is sixty seconds away. Retrying a failed sweep would pile passes on
 * top of a database that is evidently having a bad minute, so `attempts: 1`.
 * Retention is small for the same reason `removeOnComplete` is small on job
 * runs - Redis is not the audit log.
 */
export const SWEEP_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 300, count: 10 },
  removeOnFail: { age: 3_600, count: 50 },
};

export class BullJobQueue implements JobQueue {
  constructor(private readonly queue: Queue<JobRunsMessage>) {}

  /** The underlying BullMQ queue, for the worker's own bookkeeping. */
  get bull(): Queue<JobRunsMessage> {
    return this.queue;
  }

  /**
   * Registers the recurring sweep, or updates it if the interval changed.
   *
   * **BullMQ v6 API.** The legacy repeatable-jobs API (`repeat` on
   * `queue.add`, `getRepeatableJobs`, `removeRepeatable`) was removed in v6, so
   * every v5-era example of this is wrong. Job Schedulers are the replacement,
   * and `upsertJobScheduler` is keyed on the scheduler id: every worker calls
   * this at startup and the result is one schedule, not one per worker.
   *
   * Living in Redis rather than in a `setInterval` is what makes the schedule
   * survive a restart and stay single even when several workers are running.
   * Each fired message is delivered to exactly one worker, and `SKIP LOCKED` in
   * the reclaim query is what lets overlapping passes divide the work.
   */
  async scheduleSweeps(everyMs: number): Promise<void> {
    await this.queue.upsertJobScheduler(
      SCHEDULER_IDS.sweep,
      { every: everyMs },
      { name: JOB_NAMES.sweep, data: {} satisfies SweepPayload, opts: SWEEP_JOB_OPTIONS },
    );
  }

  /** Removes the recurring sweep. Tests and scripts only. */
  async unscheduleSweeps(): Promise<boolean> {
    return this.queue.removeJobScheduler(SCHEDULER_IDS.sweep);
  }

  async enqueueJobRun(jobId: string, options: EnqueueOptions = {}): Promise<EnqueueResult> {
    const existing = await this.queue.getJob(jobId);

    if (existing) {
      const state = await existing.getState();
      if (!FINISHED_STATES.has(state)) {
        // Waiting, delayed, or actively being processed. Adding again would be
        // a no-op anyway; saying so out loud makes the caller's log honest.
        return "already-queued";
      }
      // The previous message for this job is done with. Clear the id so the new
      // one is actually created rather than deduplicated away. This is the path
      // a retry and a sweeper reclaim both take.
      await existing.remove();
    }

    await this.queue.add(
      JOB_NAMES.runJob,
      { jobId },
      {
        // The job's own UUID. This is what makes enqueueing idempotent, and it
        // is why two `POST /api/jobs` retries of the same create cannot produce
        // two executions.
        jobId,
        ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
      },
    );
    return "enqueued";
  }

  async removeJobRun(jobId: string): Promise<boolean> {
    // Returns 0 for a job that does not exist and for one a worker currently
    // holds. Both mean "there is nothing here you can take away", which is what
    // the caller needs to know.
    const removed = await this.queue.remove(jobId);
    return removed > 0;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * Builds the `job-runs` queue.
 *
 * Not memoized - `getJobQueue()` in `index.ts` is the shared handle. This exists
 * separately so tests and scripts can point a queue at a throwaway name, and so
 * the integration suite can shrink the retry backoff from five seconds to
 * something a test can wait for.
 */
export function createJobRunQueue(
  name: string = QUEUE_NAMES.jobRuns,
  jobOptions: JobsOptions = {},
): Queue<JobRunsMessage> {
  return new Queue<JobRunsMessage>(name, {
    connection: getRedis(),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...jobOptions },
  });
}

export function createBullJobQueue(name?: string, jobOptions?: JobsOptions): BullJobQueue {
  return new BullJobQueue(createJobRunQueue(name, jobOptions));
}
