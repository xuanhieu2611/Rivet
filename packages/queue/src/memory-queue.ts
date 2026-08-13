import type { EnqueueOptions, EnqueueResult, JobQueue } from "@rivet/core";

/**
 * A `JobQueue` that is an array.
 *
 * This is what keeps the unit suite Redis-free. `pnpm test` runs with no
 * `REDIS_URL` and no container, and anything that needs to prove "the API
 * enqueues on create" or "the sweeper re-enqueues an orphan" asserts against
 * `enqueued` here instead of against a live Redis.
 *
 * It mirrors the BullMQ adapter's idempotency rule rather than approximating
 * it: a job id that is still outstanding is not enqueued twice. Where the two
 * differ, this one is the liar, so the integration suite is what proves the
 * real adapter.
 */
export interface RecordedEnqueue {
  jobId: string;
  options: EnqueueOptions;
  result: EnqueueResult;
}

export class InMemoryJobQueue implements JobQueue {
  /** Every call, in order, including the deduplicated ones. */
  readonly calls: RecordedEnqueue[] = [];

  /** Job ids with an outstanding message, in enqueue order. */
  private readonly outstanding: string[] = [];

  private closed = false;

  enqueueJobRun(jobId: string, options: EnqueueOptions = {}): Promise<EnqueueResult> {
    const result: EnqueueResult = this.outstanding.includes(jobId) ? "already-queued" : "enqueued";
    if (result === "enqueued") this.outstanding.push(jobId);
    this.calls.push({ jobId, options, result });
    return Promise.resolve(result);
  }

  removeJobRun(jobId: string): Promise<boolean> {
    const index = this.outstanding.indexOf(jobId);
    if (index === -1) return Promise.resolve(false);
    this.outstanding.splice(index, 1);
    return Promise.resolve(true);
  }

  /**
   * Takes every outstanding id, the way a worker draining the queue would.
   *
   * After this the ids are free to be enqueued again, which is what lets a test
   * exercise the retry and reclaim paths.
   */
  drain(): string[] {
    return this.outstanding.splice(0, this.outstanding.length);
  }

  /** Ids with a message still outstanding, without consuming them. */
  get pending(): readonly string[] {
    return this.outstanding;
  }

  /** Every id ever enqueued for real, deduplicated calls excluded. */
  get enqueued(): string[] {
    return this.calls.filter((call) => call.result === "enqueued").map((call) => call.jobId);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
