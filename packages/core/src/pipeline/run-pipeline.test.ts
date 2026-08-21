import { describe, expect, it, vi } from "vitest";

import { JobCancelledError } from "../jobs/failure";
import type { PhaseContext } from "./phase-context";
import { type Phase, simulatedPipeline } from "./phases";
import {
  abortableSleep,
  type PhaseDirective,
  type PipelineDeps,
  runPipeline,
  scaleDuration,
} from "./run-pipeline";

const PHASES: readonly Phase[] = [
  { status: "provisioning", label: "one", durationMs: 1_000, recovery: "replay" },
  { status: "analyzing", label: "two", durationMs: 2_000, recovery: "replay" },
  { status: "planning", label: "three", durationMs: 3_000, recovery: "replay" },
];

/**
 * Every test here runs the real runner at `speed: 0` with an injected sleep, so
 * the suite is synchronous, deterministic and takes microseconds. That is the
 * entire argument for the runner taking its dependencies as arguments.
 */
function harness(overrides: Partial<PipelineDeps> = {}) {
  const started: string[] = [];
  const completed: { label: string; elapsedMs: number }[] = [];
  const slept: number[] = [];
  const controller = new AbortController();

  const deps: PipelineDeps = {
    phases: PHASES,
    signal: controller.signal,
    speed: 0,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    onPhaseStart: (phase) => {
      started.push(phase.label);
      return Promise.resolve();
    },
    onPhaseComplete: (phase, elapsedMs) => {
      completed.push({ label: phase.label, elapsedMs });
      return Promise.resolve();
    },
    ...overrides,
  };

  return { deps, controller, started, completed, slept };
}

describe("runPipeline", () => {
  it("runs every phase in order", async () => {
    const { deps, started, completed } = harness();

    await runPipeline(deps);

    expect(started).toEqual(["one", "two", "three"]);
    expect(completed.map((entry) => entry.label)).toEqual(["one", "two", "three"]);
  });

  it("scales durations by speed, so tests never actually sleep", async () => {
    const { deps, slept } = harness();

    await runPipeline(deps);

    expect(slept).toEqual([0, 0, 0]);
  });

  it("passes the real elapsed time to onPhaseComplete, not the nominal one", async () => {
    let clock = 0;
    const { deps, completed } = harness({
      now: () => {
        clock += 5;
        return clock;
      },
    });

    await runPipeline(deps);

    // The nominal durations are 1000/2000/3000ms; what is reported is what the
    // injected clock measured. Milestone 2's phases will not take the time the
    // table says either.
    expect(completed.map((entry) => entry.elapsedMs)).toEqual([5, 5, 5]);
  });

  it("throws the abort reason and stops when the signal fires between phases", async () => {
    const { deps, controller, started } = harness();
    const cancelled = new JobCancelledError("cancel requested");
    const onPhaseComplete = vi.fn(() => {
      controller.abort(cancelled);
      return Promise.resolve();
    });

    await expect(runPipeline({ ...deps, onPhaseComplete })).rejects.toBe(cancelled);

    // Aborted at the end of phase one, so phase two never started.
    expect(started).toEqual(["one"]);
  });

  it("throws the abort reason when the signal fires during a phase's sleep", async () => {
    const { deps, controller, completed } = harness();
    const cancelled = new JobCancelledError("cancel requested");

    const sleep = (_ms: number, signal: AbortSignal) => {
      controller.abort(cancelled);
      return Promise.reject(signal.reason as Error);
    };

    await expect(runPipeline({ ...deps, sleep })).rejects.toBe(cancelled);

    // The phase started but never completed, which is what the timeline should
    // show: a job cancelled mid-phase, not one that quietly finished it.
    expect(completed).toEqual([]);
  });

  it("refuses to start at all when the signal is already aborted", async () => {
    const { deps, controller, started } = harness();
    const cancelled = new JobCancelledError("cancelled before we began");
    controller.abort(cancelled);

    await expect(runPipeline(deps)).rejects.toBe(cancelled);
    expect(started).toEqual([]);
  });

  it("surfaces an injected fault, after the phase has been entered", async () => {
    const { deps, started, completed } = harness();
    const boom = new Error("simulated failure");
    const fault = (phase: Phase) => (phase.label === "two" ? boom : undefined);

    await expect(runPipeline({ ...deps, fault })).rejects.toBe(boom);

    // Entered "two" before failing, so the job is genuinely in that phase's
    // status when the failure is recorded.
    expect(started).toEqual(["one", "two"]);
    expect(completed.map((entry) => entry.label)).toEqual(["one"]);
  });

  it("propagates a failed phase transition instead of carrying on", async () => {
    const { deps, started } = harness();
    const conflict = new Error("someone else owns this job");
    const onPhaseStart = () => Promise.reject(conflict);

    await expect(runPipeline({ ...deps, onPhaseStart })).rejects.toBe(conflict);
    expect(started).toEqual([]);
  });

  it("does nothing at all for an empty pipeline", async () => {
    const { deps, started } = harness({ phases: [] });
    await expect(runPipeline(deps)).resolves.toBeUndefined();
    expect(started).toEqual([]);
  });

  /**
   * The Milestone 2 half. Everything above still passes unchanged, which is the
   * check that giving phases a body did not turn into a rewrite of the runner.
   */
  describe("phases with a body", () => {
    const withBody = (run: (ctx: PhaseContext) => Promise<PhaseDirective>): readonly Phase[] => [
      { status: "provisioning", label: "one", durationMs: 1_000, recovery: "replay", run },
      { status: "analyzing", label: "two", durationMs: 2_000, recovery: "replay" },
    ];

    /** The runner only ever passes the context through, so a cast is honest here. */
    const contextFor = (phase: Phase) => ({ phase }) as PhaseContext;

    it("runs the body instead of sleeping", async () => {
      const seen: string[] = [];
      const { deps, slept } = harness({
        phases: withBody((ctx) => {
          seen.push(ctx.phase.label);
          return Promise.resolve(undefined);
        }),
        context: contextFor,
      });

      await runPipeline(deps);

      expect(seen).toEqual(["one"]);
      // Only the simulated phase slept. A real phase takes as long as the work
      // takes, and `speed` has nothing to say about it.
      expect(slept).toEqual([0]);
    });

    it("still reports the phase complete, with the time the work took", async () => {
      const { deps, completed } = harness({
        phases: withBody(() => Promise.resolve(undefined)),
        context: contextFor,
      });

      await runPipeline(deps);

      expect(completed.map((entry) => entry.label)).toEqual(["one", "two"]);
    });

    it("throws whatever the body throws, and stops there", async () => {
      const boom = new Error("clone failed");
      const { deps, started, completed } = harness({
        phases: withBody(() => Promise.reject(boom)),
        context: contextFor,
      });

      await expect(runPipeline(deps)).rejects.toBe(boom);
      expect(started).toEqual(["one"]);
      expect(completed).toEqual([]);
    });

    it("refuses to run a body with no context rather than inventing one", async () => {
      const { deps } = harness({ phases: withBody(() => Promise.resolve(undefined)) });

      // A wiring mistake, and the only way to notice it is loudly. A phase
      // silently skipped would look exactly like a phase that did its work.
      await expect(runPipeline(deps)).rejects.toThrow(/context factory/);
    });
  });

  /**
   * The Milestone 8 half: the walk is a queue, and a phase may extend it.
   *
   * Everything above still passes unchanged, which is the check that teaching
   * the runner to cycle did not change what a pipeline without a directive does.
   */
  describe("cycle directives", () => {
    /** The runner only ever passes the context through, so a cast is honest here. */
    const contextFor = (phase: Phase) => ({ phase }) as PhaseContext;

    /**
     * A three-phase stand-in for `testing -> reviewing -> finalizing`, plus a
     * `revising` that is reachable only through a directive.
     */
    function loopPhases(directive: () => PhaseDirective) {
      const revising: Phase = {
        status: "revising",
        label: "revise",
        durationMs: 0,
        recovery: "checkpoint",
      };
      const testing: Phase = {
        status: "testing",
        label: "test",
        durationMs: 0,
        recovery: "replay",
      };
      const reviewing: Phase = {
        status: "reviewing",
        label: "review",
        durationMs: 0,
        recovery: "replay",
        run: () => Promise.resolve(directive()),
      };
      const finalizing: Phase = {
        status: "finalizing",
        label: "finalize",
        durationMs: 0,
        recovery: "replay",
      };

      return { revising, testing, reviewing, finalizing };
    }

    it("inserts a directive's phases ahead of the remaining queue", async () => {
      let loops = 0;
      const phases = loopPhases(() =>
        loops++ === 0
          ? { kind: "cycle", phases: [phases.revising, phases.testing, phases.reviewing] }
          : undefined,
      );

      const { deps, started, completed } = harness({
        phases: [phases.testing, phases.reviewing, phases.finalizing],
        directivePhases: [phases.revising],
        context: contextFor,
      });

      await runPipeline(deps);

      // One trip around the loop, and `finalizing` still runs last: a directive
      // only ever inserts ahead of what is left, which is what keeps
      // `finalPhaseStatus()` honest.
      expect(started).toEqual(["test", "review", "revise", "test", "review", "finalize"]);
      expect(completed.map((entry) => entry.label)).toEqual(started);
    });

    it("carries on with the queue when a phase returns undefined", async () => {
      const phases = loopPhases(() => undefined);
      const { deps, started } = harness({
        phases: [phases.testing, phases.reviewing, phases.finalizing],
        directivePhases: [phases.revising],
        context: contextFor,
      });

      await runPipeline(deps);

      expect(started).toEqual(["test", "review", "finalize"]);
    });

    it("goes around as many times as the phase asks, since the bound is not the runner's", async () => {
      let loops = 0;
      const phases = loopPhases(() =>
        loops++ < 2
          ? { kind: "cycle", phases: [phases.revising, phases.testing, phases.reviewing] }
          : undefined,
      );

      const { deps, started } = harness({
        phases: [phases.testing, phases.reviewing, phases.finalizing],
        directivePhases: [phases.revising],
        context: contextFor,
      });

      await runPipeline(deps);

      expect(started.filter((label) => label === "revise")).toHaveLength(2);
      expect(started.at(-1)).toBe("finalize");
    });

    it("throws when a directive names a phase this pipeline does not know about", async () => {
      const stranger: Phase = {
        status: "revising",
        label: "smuggled",
        durationMs: 0,
        recovery: "replay",
      };
      const phases = loopPhases(() => ({ kind: "cycle", phases: [stranger] }));

      const { deps, started, completed } = harness({
        phases: [phases.testing, phases.reviewing, phases.finalizing],
        // Note the omission: `stranger` wears a status the pipeline uses, and is
        // still refused, because membership is by identity.
        directivePhases: [phases.revising],
        context: contextFor,
      });

      await expect(runPipeline(deps)).rejects.toThrow(/not a phase this pipeline knows about/);

      // Refused before the phase was reported complete, and nothing after it ran.
      expect(started).toEqual(["test", "review"]);
      expect(completed.map((entry) => entry.label)).toEqual(["test"]);
    });

    it("throws the abort reason unchanged when the signal fires mid-loop", async () => {
      const cancelled = new JobCancelledError("cancel requested");
      const phases = loopPhases(() => ({
        kind: "cycle",
        phases: [phases.revising, phases.testing, phases.reviewing],
      }));

      const { deps, controller, started } = harness({
        phases: [phases.testing, phases.reviewing, phases.finalizing],
        directivePhases: [phases.revising],
        context: contextFor,
      });

      const onPhaseStart = (phase: Phase) => {
        started.push(phase.label);
        // Abort on the second trip around, so the signal fires with the queue
        // already extended rather than at its original end.
        if (started.filter((label) => label === "revise").length === 2) {
          controller.abort(cancelled);
        }
        return Promise.resolve();
      };

      await expect(runPipeline({ ...deps, onPhaseStart })).rejects.toBe(cancelled);

      // A directive that never stops still stops here, which is why the runner
      // needs no loop guard of its own: the signal is the bound.
      expect(started.at(-1)).toBe("revise");
      expect(started).not.toContain("finalize");
    });
  });

  /**
   * The property the runner's whole shape exists to protect, asserted rather
   * than assumed. Real phases, the real `abortableSleep`, no fake timers: at
   * `speed: 0` every duration scales to zero and the walk is pure control flow.
   *
   * The assertion is on the durations the runner *asks* for rather than on the
   * wall clock it happens to take. A shared CI runner can deschedule this
   * process for tens of milliseconds between two adjacent statements, so an
   * elapsed-time bound tight enough to catch a reintroduced sleep is also tight
   * enough to fail on a busy machine - which is what it did, repeatedly. Every
   * requested duration being zero is the same property, and it is exact: a
   * phase that started sleeping for real would have to ask for a non-zero
   * duration to do it. The elapsed bound stays as a loose backstop against a
   * wait that never goes through `sleep` at all.
   */
  it("runs the whole simulated pipeline without an observable wait at speed 0", async () => {
    const requested: number[] = [];
    const { deps } = harness({
      phases: simulatedPipeline(),
      sleep: (ms, signal) => {
        requested.push(ms);
        return abortableSleep(ms, signal);
      },
    });

    const startedAt = performance.now();
    await runPipeline(deps);
    const elapsedMs = performance.now() - startedAt;

    // The real `abortableSleep` ran, and every duration it was handed was zero.
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((ms) => ms === 0)).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe("scaleDuration", () => {
  it("collapses to zero at speed 0", () => {
    expect(scaleDuration(5_000, 0)).toBe(0);
  });

  it("is the identity at speed 1", () => {
    expect(scaleDuration(5_000, 1)).toBe(5_000);
  });

  it("rounds, and never goes negative", () => {
    expect(scaleDuration(5_000, 0.333)).toBe(1_665);
    expect(scaleDuration(5_000, -1)).toBe(0);
  });
});

describe("abortableSleep", () => {
  it("resolves when the time passes", async () => {
    await expect(abortableSleep(1, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("rejects with the abort reason when aborted mid-sleep", async () => {
    const controller = new AbortController();
    const reason = new JobCancelledError("stop");
    const pending = abortableSleep(50, controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new JobCancelledError("already stopped");
    controller.abort(reason);

    await expect(abortableSleep(50, controller.signal)).rejects.toBe(reason);
  });

  it("returns straight away for a non-positive duration", async () => {
    await expect(abortableSleep(0, new AbortController().signal)).resolves.toBeUndefined();
  });
});
