import type { PhaseContext } from "./phase-context";
import type { Phase } from "./phases";

/**
 * What a phase may ask the runner to do next.
 *
 * `undefined` is the ordinary answer and means "carry on with the queue", which
 * is what every phase before Milestone 8 does. A `cycle` directive asks for a
 * list of phases to run *before* the rest of the queue, which is how the review
 * loop expresses `reviewing -> revising -> testing -> reviewing` without either
 * hiding an implementer session inside a `reviewing` body or pre-expanding the
 * pipeline with skipped copies of the loop.
 *
 * The runner does not know what a review is, and nothing here mentions one. It
 * knows that a phase may name known phases to run next, and that is the whole
 * vocabulary.
 */
export type PhaseDirective = { kind: "cycle"; phases: readonly Phase[] } | undefined;

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
   * Phases a directive may name that are not in the walk to begin with.
   *
   * `revising` is the reason this exists: it is never in `PHASE_TEMPLATE`, only
   * ever entered through a `cycle` directive, and yet it has to be a phase this
   * pipeline *knows about* or the runner's structural check would refuse the
   * only directive the product actually issues. Everything already in `phases`
   * is known without being repeated here.
   *
   * Membership is by identity rather than by status, which is the point: a
   * directive can only re-run bodies the worker was configured with, and cannot
   * conjure one by handing back a freshly built object wearing a known status.
   */
  directivePhases?: readonly Phase[];

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
   * Builds the context a phase with a body runs against.
   *
   * Per phase rather than per run because a command row is stamped with the
   * phase that produced it. Required only when some phase actually has a `run`;
   * a fully simulated pipeline never asks for one, which is what keeps the
   * Milestone 1 tests and the `RIVET_SANDBOX=off` path free of any of this.
   */
  context?: (phase: Phase) => PhaseContext;

  /**
   * Called before the phase's work, and the place the status transition goes.
   *
   * Anything it throws aborts the run, which is intentional: if the transition
   * into a phase failed then something else owns this job and continuing would
   * be writing over it.
   */
  onPhaseStart: (phase: Phase) => Promise<void>;

  /** Called after the phase's work, with how long it really took. */
  onPhaseComplete: (phase: Phase, elapsedMs: number, directive: PhaseDirective) => Promise<void>;

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
 *
 * Milestone 8 turns the walk from a `for...of` over a frozen list into a
 * mutable queue, because a phase may now return a `cycle` directive whose
 * phases are spliced in ahead of whatever is left. The runner enforces exactly
 * one structural rule about that - a directive may only name phases this
 * pipeline knows about - and holds no opinion at all about why a phase asked.
 *
 * There is deliberately **no runner-side loop counter.** A bound kept here
 * would be per-attempt, so a worker killed mid-loop would hand its replacement
 * a fresh one, which is precisely the failure `AGENTS.md` calls out for budgets:
 * the review bound is durable job state (`review_loops` against
 * `max_review_loops`) and is spent by the phase that issues the directive,
 * before it issues it. What the runner does keep is the property that makes an
 * unbounded loop survivable anyway: `signal.throwIfAborted()` runs at every
 * phase boundary, so a cancel or the job deadline ends the walk on the next
 * boundary no matter how many times the queue has been extended.
 */
export async function runPipeline(deps: PipelineDeps): Promise<void> {
  const now = deps.now ?? Date.now;

  // Identity, not status: see `directivePhases`. Built once, because the set of
  // phases a worker was configured with cannot change mid-run. Pipelines built
  // by `buildPipeline` carry the same metadata on their array, so direct callers
  // do not have to unpack it merely to run the queue.
  const attachedDirectivePhases = (
    deps.phases as readonly Phase[] & { readonly directivePhases?: readonly Phase[] }
  ).directivePhases;
  const known = new Set<Phase>([
    ...deps.phases,
    ...(deps.directivePhases ?? attachedDirectivePhases ?? []),
  ]);
  const queue: Phase[] = [...deps.phases];

  for (let phase = queue.shift(); phase !== undefined; phase = queue.shift()) {
    // Checked before each phase as well as after each sleep, so a signal that
    // aborted during a callback is noticed rather than costing a whole extra
    // phase of work.
    deps.signal.throwIfAborted();

    const startedAt = now();
    await deps.onPhaseStart(phase);

    const fault = deps.fault?.(phase);
    if (fault) throw fault;

    // The whole of Milestone 2's change to the runner. A phase either does its
    // work or pretends to, and which one it is belongs to the phase rather than
    // to the thing walking the list.
    let directive: PhaseDirective;
    if (phase.run) {
      if (!deps.context) {
        throw new Error(
          `Phase "${phase.label}" has a body but the pipeline was built without a context factory.`,
        );
      }
      directive = await phase.run(deps.context(phase));
    } else {
      await deps.sleep(scaleDuration(phase.durationMs, deps.speed), deps.signal);
    }

    // Validated before the phase is reported complete, because a directive
    // naming something this pipeline has no body for is a wiring mistake rather
    // than a job outcome, and a phase that ends in one did not succeed.
    if (directive) assertKnownPhases(phase, directive, known);

    deps.signal.throwIfAborted();

    await deps.onPhaseComplete(phase, now() - startedAt, directive);

    // Ahead of the remaining queue, never appended to the end of it - which is
    // what keeps `finalPhaseStatus()` true: `finalizing` is still the last thing
    // the queue holds no matter how many times the loop goes around.
    if (directive) queue.unshift(...directive.phases);
  }
}

/**
 * Refuses a directive naming a phase the pipeline was not built with.
 *
 * Loud rather than skipped, for the same reason a body with no context factory
 * is: a phase quietly dropped from the walk looks exactly like a phase that ran
 * and had nothing to say.
 */
function assertKnownPhases(
  source: Phase,
  directive: NonNullable<PhaseDirective>,
  known: ReadonlySet<Phase>,
): void {
  for (const next of directive.phases) {
    if (!known.has(next)) {
      throw new Error(
        `Phase "${source.label}" asked to cycle through "${next.label}" (${next.status}), which is not a phase this pipeline knows about.`,
      );
    }
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
