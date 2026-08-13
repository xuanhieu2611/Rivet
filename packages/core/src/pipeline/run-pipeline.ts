import type { Phase } from "./phases";

/**
 * The phase runner.
 *
 * Every dependency arrives as an argument - the clock, the sleep, both
 * callbacks, the fault injector, the abort signal. Nothing is imported and
 * nothing is read from the environment, which has one concrete payoff: the
 * whole pipeline runs in well under a millisecond at `speed: 0`, with no
 * `vi.useFakeTimers` gymnastics and no test that sleeps in CI. It is also what
 * lets Milestone 2 swap the phase bodies for sandbox calls without the runner
 * noticing.
 */
export interface PipelineDeps {
  phases: readonly Phase[];

  /**
   * Cancellation and timeout both arrive here.
   *
   * Whatever aborted the signal is thrown out of `runPipeline` unchanged, so
   * the caller's `classify()` sees a `JobCancelledError` or a `JobTimedOutError`
   * rather than a generic abort it would have to guess about.
   */
  signal: AbortSignal;

  /** Must reject with `signal.reason` when the signal aborts mid-sleep. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  /**
   * Called before the phase's work, and the place the status transition goes.
   *
   * Anything it throws aborts the run, which is intentional: if the transition
   * into a phase failed then something else owns this job and continuing would
   * be writing over it.
   */
  onPhaseStart: (phase: Phase) => Promise<void>;

  /** Called after the phase's work, with how long it really took. */
  onPhaseComplete: (phase: Phase, elapsedMs: number) => Promise<void>;

  /**
   * Fault injection. Returns an error to throw, or nothing to proceed.
   *
   * Consulted *after* `onPhaseStart`, so a fault at `testing` fails a job that
   * is genuinely in `testing`. Failing it while still in the previous phase
   * would make the timeline lie about where the trouble was.
   */
  fault?: (phase: Phase) => Error | undefined;

  /** Scales every duration. Tests pass 0; the demo passes 1. */
  speed: number;

  /** Injectable clock, for measuring elapsed time. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Walks the phases in order, or throws the first thing that goes wrong.
 *
 * Returns nothing. The job's state lives in Postgres and the callbacks are what
 * put it there; a return value here would be a second, weaker copy of it.
 */
export async function runPipeline(deps: PipelineDeps): Promise<void> {
  const now = deps.now ?? Date.now;

  for (const phase of deps.phases) {
    // Checked before each phase as well as after each sleep, so a signal that
    // aborted during a callback is noticed rather than costing a whole extra
    // phase of work.
    deps.signal.throwIfAborted();

    const startedAt = now();
    await deps.onPhaseStart(phase);

    const fault = deps.fault?.(phase);
    if (fault) throw fault;

    await deps.sleep(scaleDuration(phase.durationMs, deps.speed), deps.signal);
    deps.signal.throwIfAborted();

    await deps.onPhaseComplete(phase, now() - startedAt);
  }
}

/** Never negative, always an integer - `setTimeout` is fussy about both. */
export function scaleDuration(durationMs: number, speed: number): number {
  return Math.max(0, Math.round(durationMs * speed));
}

/**
 * `setTimeout` that rejects with the abort reason instead of finishing.
 *
 * The default `sleep` for `PipelineDeps`. It lives here rather than in the
 * worker because it is the reference implementation of the contract the runner
 * documents, and getting it subtly wrong - resolving on abort, or leaking the
 * listener - would make every cancellation test pass for the wrong reason.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
