import type { JobStatus } from "@rivet/contracts";
import {
  abortableSleep,
  appendEvent,
  claimJob,
  classify,
  createPhaseContextFactory,
  describeError,
  failureCategoryFor,
  JobTimedOutError,
  type Phase,
  releaseJob,
  runPipeline,
  SandboxHolder,
  simulatedPipeline,
  transitionJob,
  TransitionConflictError,
  WorkerShuttingDownError,
} from "@rivet/core";
import { JOB_NAMES, type JobRunsMessage } from "@rivet/queue";
import { DelayedError, type Job, UnrecoverableError } from "bullmq";

import type { WorkerConfig } from "./config";
import type { FaultInjection } from "./faults";
import { startHeartbeat } from "./heartbeat";
import type { Logger } from "./logger";

/**
 * One run of one job, from claim to terminal status.
 *
 * The shape to hold on to: **BullMQ delivers a job id and dispatch generation.**
 * Everything else - whether this worker may run the job, what it did, how it
 * ended - is a Postgres fact guarded by the lease. A stale generation can reach
 * this process, but it cannot claim or write the job.
 *
 * Two counters exist here and they mean different things. `job.attemptsMade` is
 * BullMQ's per-message retry count; `jobs.attempt_count` is how many times any
 * worker has claimed this job, including reclaims after a crash BullMQ never
 * heard about. Both are logged. Postgres is the one that is true.
 */

/**
 * The in-flight runs this process owns.
 *
 * Shutdown needs to reach into every running job and abort it, and it has to be
 * able to tell "the worker is going away" apart from every other reason a job
 * might stop - that difference is release-and-requeue versus mark-as-failed.
 */
export class RunRegistry {
  private readonly controllers = new Map<string, AbortController>();
  private draining = false;

  register(jobId: string, controller: AbortController): void {
    this.controllers.set(jobId, controller);
  }

  release(jobId: string): void {
    this.controllers.delete(jobId);
  }

  get size(): number {
    return this.controllers.size;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /** Aborts every run with `WorkerShuttingDownError` and refuses new ones. */
  drain(): void {
    this.draining = true;
    for (const [jobId, controller] of this.controllers) {
      controller.abort(new WorkerShuttingDownError(`Worker is shutting down; releasing ${jobId}.`));
    }
  }
}

export interface ProcessorDeps {
  config: WorkerConfig;
  workerId: string;
  log: Logger;
  runs: RunRegistry;
  /** Overridable so a test can drive a two-phase pipeline. */
  phases?: readonly Phase[];
  /**
   * Rebuilds a pipeline after per-run fault injection has been created.
   *
   * Sandbox faults need a provider wrapper that belongs to this attempt, not
   * to the worker process: two jobs may be in different fault phases at the
   * same time. The ordinary `phases` override remains for tests that do not
   * need a sandbox-backed pipeline.
   */
  phaseFactory?: (injection: FaultInjection) => readonly Phase[];
  /**
   * Fault injection and the sleep that goes with it.
   *
   * A factory rather than a value because `hang` is per-run state: two jobs
   * running concurrently on this worker must not share the flag that decides
   * whether the current phase ignores its abort signal.
   */
  faults?: () => FaultInjection;
  /**
   * Runs one reconciliation pass. Invoked for `sweep` messages.
   *
   * Optional so a test can build a processor that only runs jobs. A sweep
   * message arriving without one is logged and dropped rather than failed:
   * there is nothing to retry, and the schedule will fire again shortly.
   */
  sweep?: () => Promise<void>;
}

export function createProcessor(deps: ProcessorDeps) {
  const { config, workerId, runs } = deps;
  const phases = deps.phases ?? simulatedPipeline();
  const faults: () => FaultInjection = deps.faults ?? (() => ({ sleep: abortableSleep }));

  return async function processMessage(job: Job<JobRunsMessage>, token?: string): Promise<void> {
    // Two kinds of message share the `job-runs` queue, and they are told apart
    // by name rather than by payload shape. A sweep carries no data at all.
    if (job.name === JOB_NAMES.sweep) {
      if (!deps.sweep) {
        deps.log.warn("received a sweep message but no sweeper is wired up");
        return;
      }
      return deps.sweep();
    }

    const { jobId, dispatchGeneration = 0 } = job.data;
    if (!jobId) {
      // A `run-job` message with no job id cannot be repaired by retrying it.
      throw new UnrecoverableError(`Message ${job.id ?? "(no id)"} carries no jobId.`);
    }

    const log = deps.log.child({
      jobId,
      dispatchGeneration,
      bullAttempt: job.attemptsMade + 1,
    });

    // Already draining when this arrived. Do not start work that shutdown is
    // about to interrupt; put the message back and let the next worker have it.
    if (runs.isDraining) {
      log.info("worker is draining; returning the message to the queue");
      return requeue(job, token);
    }

    const claimed = await claimJob(jobId, workerId, config.leaseSeconds, dispatchGeneration);
    if (!claimed) {
      // Cancelled before anyone got to it, already terminal, a duplicate
      // message, or another worker won the race. None of these are errors, and
      // none of them should retry.
      log.info("not claimable; another owner or already finished");
      return;
    }

    log.info({ attemptCount: claimed.attemptCount }, "claimed");

    const controller = new AbortController();
    runs.register(jobId, controller);

    // The whole-run budget. Separate from the lease: the lease asks "is this
    // worker alive", this asks "has this job taken too long", and a wedged job
    // can very much answer yes to both.
    //
    // It is also the one deadline that does not merely *ask* the run to stop.
    // Everything else - cancellation, lease loss, shutdown - is cooperative,
    // and cooperative is the right default because a phase that is interrupted
    // between its own writes is worse than one that finishes its sentence. A
    // budget cannot be cooperative, though, because the thing it exists to
    // catch is precisely a phase that has stopped listening.
    const deadline = createDeadline(
      claimed.maxDurationSeconds * 1_000,
      () => new JobTimedOutError(`Job exceeded its ${claimed.maxDurationSeconds}s budget.`),
      controller,
    );

    const stopHeartbeat = startHeartbeat({
      jobId,
      leaseOwner: workerId,
      leaseSeconds: config.leaseSeconds,
      intervalMs: config.heartbeatSeconds * 1_000,
      controller,
      log,
    });

    // The status this worker believes the job is in. Every transition is a
    // compare-and-swap against it, so if the belief is ever wrong the write
    // fails loudly instead of overwriting whatever is really there.
    let currentStatus: JobStatus = claimed.status;

    const injection = faults();

    // The run's container, owned here rather than by the pipeline that creates
    // it. That placement is the whole of the milestone's cleanup story: the
    // processor abandons a hung phase promise rather than waiting for it (see
    // the `Promise.race` below), so destruction cannot live inside the thing
    // that might never return. The `provisioning` phase's only obligation is to
    // put the handle in here the instant `create()` resolves.
    const sandboxes = new SandboxHolder();

    // Whether this run is still entitled to write to the job. Everything except
    // a lost lease is; see `handleFailure`.
    let mayWrite = true;

    try {
      // Build after the try begins so a faulty per-run factory follows the same
      // cleanup path as every other phase failure.
      const runPhases = deps.phaseFactory?.(injection) ?? phases;
      const pipeline = runPipeline({
        phases: runPhases,
        signal: controller.signal,
        speed: config.pipelineSpeed,
        sleep: injection.sleep,
        ...(injection.fault ? { fault: injection.fault } : {}),

        context: createPhaseContextFactory({
          job: claimed,
          // The fencing token. Every write a phase makes carries it, so a phase
          // still running after the job was reclaimed writes nothing.
          leaseOwner: workerId,
          sandboxes,
          signal: controller.signal,
          log,
          maxOutputBytes: config.sandbox.maxOutputBytes,
          artifactMaxBytes: config.artifactMaxBytes,
          checkpointMaxBytes: config.checkpointMaxBytes,
          checkpointTimeoutMs: config.checkpointTimeoutMs,
          repositoryDir: `${config.sandbox.workdir}/repo`,
        }),

        onPhaseStart: async (phase) => {
          if (phase.status === currentStatus) {
            // The claim already moved the job into the first phase's status, so
            // there is nothing to transition - but the phase still happened and
            // the timeline should say so. `transitionJob` rejects same-status
            // moves outright, which is why this is not one.
            await appendEvent({
              jobId,
              type: "phase.started",
              message: phase.label,
              data: { phase: phase.label },
              leaseOwner: workerId,
            });
            return;
          }

          await transitionJob({
            jobId,
            from: currentStatus,
            to: phase.status,
            leaseOwner: workerId,
            type: "phase.started",
            message: phase.label,
            data: { phase: phase.label },
          });
          currentStatus = phase.status;
        },

        onPhaseComplete: async (phase, elapsedMs) => {
          log.debug({ phase: phase.label, elapsedMs }, "phase complete");
          await appendEvent({
            jobId,
            type: "phase.completed",
            message: `${phase.label} finished`,
            data: { phase: phase.label, durationMs: elapsedMs },
            leaseOwner: workerId,
          });
        },
      });

      // A hung phase is abandoned rather than waited for. Its promise keeps
      // running with nobody listening, so it gets a catch of its own: every
      // write it might still attempt is a compare-and-swap under a lease this
      // run is about to give up, and will simply fail - but an unhandled
      // rejection would take the whole worker down with it.
      //
      // Milestone 2 is the harder version of this problem, because an abandoned
      // phase owns a container rather than a `setTimeout`. That is exactly why
      // the holder is out here: the `finally` destroys the container without
      // needing the phase to come back and hand it over, and the command that
      // phase was waiting on dies with it.
      pipeline.catch(() => undefined);
      await Promise.race([pipeline, deadline.expiry]);

      // Cleanup is still part of the leased attempt. Recording its lifecycle
      // before the terminal transition means the event can use the same fence
      // as every other phase write, rather than becoming a stale post-release
      // write in `finally`.
      await destroySandbox({ sandboxes, jobId, leaseOwner: workerId, mayWrite: true, log });

      await transitionJob({
        jobId,
        from: currentStatus,
        to: "completed",
        leaseOwner: workerId,
        type: "job.completed",
        message: "Job completed.",
        // The lease is cleared on the way out so the sweeper never has to think
        // about a finished job at all.
        patch: (_job, now) => ({ completedAt: now, leaseOwner: null, leaseExpiresAt: null }),
      });

      log.info("completed");
    } catch (error) {
      // Computed before `handleFailure`, which throws on two of its branches
      // and would otherwise never let this be read. `classify` is pure, so
      // asking twice costs nothing.
      mayWrite = classify(error) !== "lease_lost";
      // Destroy the attempt before `handleFailure` can clear or hand back its
      // lease. A stale worker may still clean up its own container, but it may
      // not append the cleanup event after discovering that it lost ownership.
      await destroySandbox({ sandboxes, jobId, leaseOwner: workerId, mayWrite, log });
      await handleFailure(error, { job, token, jobId, currentStatus, workerId, log });
    } finally {
      deadline.cancel();
      // Fallback for failures that happen before the main try body reaches its
      // cleanup point. The holder is idempotent, so the normal path has nothing
      // left here to destroy.
      await destroySandbox({ sandboxes, jobId, leaseOwner: workerId, mayWrite, log });
      await stopHeartbeat();
      runs.release(jobId);
    }
  };
}

interface DestroyContext {
  sandboxes: SandboxHolder;
  jobId: string;
  leaseOwner: string;
  mayWrite: boolean;
  log: Logger;
}

/**
 * The one exit every run takes, whatever happened on the way.
 *
 * Six of them, and they are worth naming because the container has to go on all
 * six: completed, failed, cancelled, timed out, lease lost, worker shutting
 * down. `lease_lost` is the interesting one - the run deliberately writes
 * nothing to Postgres, because another worker owns that job now and every write
 * would land in the middle of its run - but it must still destroy its own
 * container. Not writing to a job someone else owns and not leaking your own
 * process's resources are different obligations, and only the first one is
 * about ownership.
 *
 * This cannot throw. It runs from both the leased cleanup point and the
 * processor's `finally` fallback, and a cleanup failure that replaces the error
 * that actually mattered turns a two-minute diagnosis into an hour. What it
 * cannot remove, the sweeper's reaper removes later - the same backstop argument
 * the lease makes.
 */
async function destroySandbox(context: DestroyContext): Promise<void> {
  const { sandboxes, jobId, leaseOwner, mayWrite, log } = context;
  try {
    const containerId = await sandboxes.destroy();
    if (!containerId) return;

    log.info({ containerId }, "sandbox destroyed");
    if (!mayWrite) return;

    await appendEvent({
      jobId,
      type: "sandbox.destroyed",
      message: `Sandbox ${containerId.slice(0, 12)} removed.`,
      data: { containerId },
      leaseOwner,
    });
  } catch (error) {
    log.error({ err: error }, "could not clean up the sandbox; the reaper will get it");
  }
}

/**
 * A promise that rejects when the budget runs out, and never otherwise.
 *
 * It aborts the controller too, so a run that *is* still listening stops at its
 * next phase boundary instead of being abandoned mid-phase. The rejection is
 * the backstop for the run that is not listening.
 */
function createDeadline(
  ms: number,
  error: () => Error,
  controller: AbortController,
): { expiry: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;

  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const timedOut = error();
      controller.abort(timedOut);
      reject(timedOut);
    }, ms);
    // Never the reason this process stays alive.
    timer.unref();
  });

  // Nothing awaits this promise once the run has finished normally, and a
  // rejection nobody is listening to is an unhandled rejection.
  expiry.catch(() => undefined);

  return { expiry, cancel: () => clearTimeout(timer) };
}

interface FailureContext {
  job: Job<JobRunsMessage>;
  token: string | undefined;
  jobId: string;
  currentStatus: JobStatus;
  workerId: string;
  log: Logger;
}

/**
 * One error, two systems to tell about it.
 *
 * Postgres needs a status and a `failure_category`; BullMQ needs to know
 * whether to try again. `classify()` is what keeps those two answers from
 * drifting apart, and the switch below is the entire retry policy.
 */
async function handleFailure(error: unknown, context: FailureContext): Promise<void> {
  const { job, jobId, currentStatus, workerId, log } = context;
  const outcome = classify(error);

  switch (outcome) {
    case "lease_lost": {
      // Deliberately writes NOTHING. Not a status, not an event, not a lease
      // clear. Another worker owns this job now and every write from here would
      // land in the middle of its run - which is the exact split-brain the
      // lease exists to prevent. Walking away is the whole correct behaviour.
      log.warn({ err: error }, "lease lost mid-run; leaving the job alone");
      return;
    }

    case "shutting_down": {
      // A deploy or a Ctrl-C is not a job failure and must not cost an attempt.
      // Hand the lease back so the next worker can claim immediately rather
      // than waiting out the expiry, then put the message back on the queue.
      await releaseJob(jobId, workerId, {
        reason: "Worker shut down; job handed back to the queue.",
        type: "job.reclaimed",
      });
      log.info("released on shutdown");
      return requeue(context.job, context.token);
    }

    case "cancelled": {
      // A cancelled job is not a failed job, and the message is finished
      // normally: there is nothing left to retry.
      await finishBadly(jobId, currentStatus, "cancelled", workerId, error, log);
      return;
    }

    case "timed_out": {
      await finishBadly(jobId, currentStatus, "timed_out", workerId, error, log);
      // v6: `UnrecoverableError`, not the v5 `job.discard()`. A job that blew
      // its budget will blow it again.
      throw new UnrecoverableError(describeError(error));
    }

    case "budget_exceeded": {
      // Its own terminal status rather than `failed`, because a job that ran
      // out of budget did not go wrong - it was stopped, and the dashboard
      // should say which. Never retried: a second attempt would start from zero
      // and spend the same budget reaching the same ceiling.
      await finishBadly(jobId, currentStatus, "budget_exceeded", workerId, error, log);
      throw new UnrecoverableError(describeError(error));
    }

    case "retryable": {
      // A transient error gets the normal release-and-rethrow path while
      // BullMQ still has another delivery available. Once the message has
      // spent its last attempt, leaving the row in `queued` would lose the
      // category that explains why it never completed and make the sweeper
      // guess `lease_expired` later. Persist the error we actually observed.
      if (isLastBullAttempt(job)) {
        await finishBadly(jobId, currentStatus, "failed", workerId, error, log);
        throw new UnrecoverableError(describeError(error));
      }

      await releaseJob(jobId, workerId, {
        reason: `Retrying after a transient failure: ${describeError(error)}`,
        type: "job.retry_scheduled",
      });
      log.warn({ err: error }, "transient failure; released for retry");
      throw error;
    }

    case "terminal": {
      await finishBadly(jobId, currentStatus, "failed", workerId, error, log);
      throw new UnrecoverableError(describeError(error));
    }
  }
}

/**
 * BullMQ counts attempts from zero in `attemptsMade`, while the configured
 * `attempts` value is the total number of deliveries. The final retryable
 * failure is terminal from Rivet's point of view so its real category is not
 * replaced by the sweeper's generic `lease_expired` category.
 */
function isLastBullAttempt(job: Job<JobRunsMessage>): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/** The shared write for cancelled, timed out and failed: one terminal status. */
async function finishBadly(
  jobId: string,
  from: JobStatus,
  to: Extract<JobStatus, "cancelled" | "timed_out" | "failed" | "budget_exceeded">,
  workerId: string,
  error: unknown,
  log: Logger,
): Promise<void> {
  try {
    await transitionJob({
      jobId,
      from,
      to,
      leaseOwner: workerId,
      type: to === "failed" ? "job.failed" : "job.status_changed",
      message: describeError(error),
      data: { error: describeError(error), failureCategory: failureCategoryFor(error) },
      patch: (_job, now) => ({
        completedAt: now,
        failureReason: describeError(error),
        failureCategory: failureCategoryFor(error),
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    });
    log.info({ status: to }, "run ended");
  } catch (cause) {
    if (cause instanceof TransitionConflictError) {
      // Something moved the job between the failure and this write - most
      // likely a cancel that landed first. Its version wins; ours was already
      // stale by the time we tried.
      log.warn({ err: cause }, "could not record the outcome; the job moved on without us");
      return;
    }
    throw cause;
  }
}

/**
 * Puts the message back without consuming an attempt.
 *
 * BullMQ v6's way of saying "not now": move the active job to delayed and throw
 * `DelayedError`, which the worker recognises as a deliberate hand-back rather
 * than a failure. Re-adding the job instead would deduplicate against its own
 * still-active id and quietly do nothing.
 */
async function requeue(job: Job<JobRunsMessage>, token?: string): Promise<void> {
  await job.moveToDelayed(Date.now(), token);
  throw new DelayedError();
}
