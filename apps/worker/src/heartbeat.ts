import {
  ATTR_WORKER_ID,
  heartbeat,
  JobCancelledError,
  LeaseLostError,
  METRIC_WORKER_HEARTBEAT,
  NOOP_TELEMETRY,
  recordLevel,
  type Telemetry,
} from "@rivet/core";

import type { Logger } from "./logger";

/**
 * The interval loop that keeps a claim alive, and the two ways it ends a run.
 *
 * It is deliberately the only thing in the worker that can abort a job from the
 * outside, because both reasons to do so - the lease was lost, or a cancel was
 * requested - come back on the same round trip. Everything downstream just sees
 * an aborted `AbortSignal` carrying one of two named errors.
 */
export interface HeartbeatOptions {
  jobId: string;
  leaseOwner: string;
  leaseSeconds: number;
  intervalMs: number;
  /** Aborted with a named error when the lease is lost or a cancel lands. */
  controller: AbortController;
  log: Logger;
  /** Where worker liveness samples go. Absent, the sample is a no-op. */
  telemetry?: Telemetry;
}

/** Stops the loop and waits for any tick already in flight. */
export type StopHeartbeat = () => Promise<void>;

export function startHeartbeat(options: HeartbeatOptions): StopHeartbeat {
  const { jobId, leaseOwner, leaseSeconds, controller, log } = options;
  const telemetry = options.telemetry ?? NOOP_TELEMETRY;
  const workerAttributes = { [ATTR_WORKER_ID]: leaseOwner };

  // A worker is not live for this lease until the first round trip succeeds.
  recordLevel(
    telemetry,
    METRIC_WORKER_HEARTBEAT,
    0,
    workerAttributes,
    "Whether the worker's latest lease heartbeat succeeded.",
  );

  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return;

    try {
      const result = await heartbeat(jobId, leaseOwner, leaseSeconds);

      if (!result) {
        recordLevel(
          telemetry,
          METRIC_WORKER_HEARTBEAT,
          0,
          workerAttributes,
          "Whether the worker's latest lease heartbeat succeeded.",
        );
        // The `lease_owner` predicate did not match: something reclaimed this
        // job while we were working on it. Abort immediately and, critically,
        // write nothing further to the row - its new owner is mid-flight.
        log.warn("lease lost; standing down");
        controller.abort(
          new LeaseLostError(`Lease on job ${jobId} is no longer held by ${leaseOwner}.`),
        );
        return;
      }

      recordLevel(
        telemetry,
        METRIC_WORKER_HEARTBEAT,
        1,
        workerAttributes,
        "Whether the worker's latest lease heartbeat succeeded.",
      );

      if (result.cancelRequested) {
        log.info("cancel requested; aborting between phases");
        controller.abort(new JobCancelledError(`Job ${jobId} was cancelled.`));
        return;
      }

      log.debug({ status: result.status }, "lease renewed");
    } catch (error) {
      recordLevel(
        telemetry,
        METRIC_WORKER_HEARTBEAT,
        0,
        workerAttributes,
        "Whether the worker's latest lease heartbeat succeeded.",
      );
      // A failed heartbeat is not a failed job. Neon hiccups, and the lease has
      // two more intervals of slack by construction - that is what the
      // `heartbeat * 3 <= lease` invariant buys. If the database really is gone
      // the lease lapses on its own and the sweeper does the right thing, which
      // is a better outcome than this worker killing a healthy job over one
      // dropped connection.
      log.warn({ err: error }, "heartbeat failed; will retry on the next interval");
    }
  };

  const timer = setInterval(() => {
    // Chained rather than fired in parallel, so a slow round trip cannot stack
    // up overlapping heartbeats against the same row.
    inFlight = inFlight.then(tick);
  }, options.intervalMs);

  // Do not keep the process alive just to heartbeat.
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
