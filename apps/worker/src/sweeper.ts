import {
  isJobLive,
  isQuietSweep,
  type JobQueue,
  type SandboxProvider,
  sweepJobs,
} from "@rivet/core";

import type { WorkerConfig } from "./config";
import type { Logger } from "./logger";

/**
 * The sweep, as the worker runs it.
 *
 * All the reasoning lives in `packages/core/src/jobs/sweeper.ts`; this is the
 * thin part that decides how often it happens and what it logs. It is a BullMQ
 * message rather than a `setInterval` for two reasons that are the same reason:
 * the schedule lives in Redis, so N workers still produce one sweep per
 * interval instead of N, and it survives a restart without a worker needing to
 * remember it was the one holding the timer.
 */
export interface SweepDeps {
  queue: JobQueue;
  config: WorkerConfig;
  log: Logger;
  /**
   * The sandbox reaper, when this worker has one.
   *
   * Absent under `RIVET_SANDBOX=off`, where no container was ever created and
   * asking Docker about it would be the only thing in the process that needed a
   * daemon.
   */
  sandbox?: SandboxProvider;
}

export function createSweepRunner(deps: SweepDeps): () => Promise<void> {
  const { queue, config, log } = deps;

  return async function runSweep(): Promise<void> {
    const started = Date.now();
    // Containers first. A pass that reclaims a job puts it back in `queued`, and
    // the container its dead worker left behind should be gone before another
    // worker picks that job up - not because anything breaks otherwise (the new
    // run creates its own container and the old one is invisible to it) but
    // because "one container per running job" is a much easier thing to check by
    // eye than "one container per running job, plus however many are pending a
    // sweep".
    await reapSandboxes(deps);

    const report = await sweepJobs(queue, {
      maxAttempts: config.maxAttempts,
      // A row must have been sitting in `queued` for a full sweep interval
      // before its message is presumed missing. Anything shorter would flag
      // every job in the fraction of a second between its insert and its
      // enqueue - harmless, since re-enqueueing is idempotent, but it would
      // fill the log with reconciliations that reconciled nothing.
      orphanedQueuedAfterMs: config.sweepIntervalMs,
    });

    const summary = {
      durationMs: Date.now() - started,
      reclaimed: report.expiredLeases.filter((r) => r.outcome === "reclaimed").length,
      cancelled: report.expiredLeases.filter((r) => r.outcome === "cancelled").length,
      failed: report.expiredLeases.filter((r) => r.outcome === "failed").length,
      skipped: report.expiredLeases.filter((r) => r.outcome === "skipped").length,
      requeued: report.orphanedQueued.filter((r) => r.outcome === "enqueued").length,
      unreachable: report.orphanedQueued.filter((r) => r.outcome === "error").length,
    };

    // Quiet is the normal answer, once a minute, forever. Logging it at `info`
    // would train everyone to ignore the one line that matters.
    if (isQuietSweep(report)) {
      log.debug(summary, "sweep found nothing");
      return;
    }

    log.info(summary, "sweep reconciled jobs");

    for (const result of report.expiredLeases) {
      log.warn(
        {
          jobId: result.jobId,
          from: result.from,
          leaseOwner: result.leaseOwner,
          attemptCount: result.attemptCount,
          outcome: result.outcome,
        },
        "expired lease",
      );
    }

    for (const result of report.orphanedQueued) {
      if (result.outcome === "enqueued") {
        // The dual-write gap, observed. Worth a line every time: it means a row
        // committed and its message did not, and knowing how often that happens
        // is the difference between "the sweeper is a backstop" and "the sweeper
        // is load-bearing".
        log.warn({ jobId: result.jobId }, "queued row had no message; re-enqueued");
      } else if (result.outcome === "error") {
        log.error({ jobId: result.jobId, err: result.error }, "could not re-enqueue orphaned job");
      }
    }
  };
}

/**
 * The third reconciliation loop, and the one `kill -9` makes necessary.
 *
 * The lease reconciles Postgres against a worker that stopped answering, and
 * `requeueOrphanedJobs` reconciles Postgres against Redis. This reconciles
 * Postgres against the Docker daemon, which holds state nobody else knows
 * about: a worker killed outright never reaches its `finally`, so the container
 * it created outlives every process that knew it existed. The label is the only
 * handle left on it, and `isJobLive` is the only authority on whether it is
 * still wanted.
 *
 * Failures here are logged, never thrown. A daemon that is temporarily
 * unreachable must not abort a sweep whose job-reconciliation half is perfectly
 * able to run, and the next pass will try again in a minute.
 */
async function reapSandboxes(deps: SweepDeps): Promise<void> {
  if (!deps.sandbox) return;

  try {
    const removed = await deps.sandbox.reap((jobId) => isJobLive(jobId));
    if (removed.length > 0) {
      deps.log.warn(
        { count: removed.length, category: "sandbox_leaked" },
        "reaped sandboxes whose jobs are no longer running",
      );
    }
  } catch (error) {
    deps.log.error({ err: error }, "could not reap sandboxes");
  }
}
