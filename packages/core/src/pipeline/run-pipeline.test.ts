import { describe, expect, it, vi } from "vitest";

import { JobCancelledError } from "../jobs/failure";
import type { Phase } from "./phases";
import { abortableSleep, type PipelineDeps, runPipeline, scaleDuration } from "./run-pipeline";

const PHASES: readonly Phase[] = [
  { status: "provisioning", label: "one", durationMs: 1_000 },
  { status: "analyzing", label: "two", durationMs: 2_000 },
  { status: "planning", label: "three", durationMs: 3_000 },
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
