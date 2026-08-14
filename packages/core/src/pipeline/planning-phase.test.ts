import type { JobDetail } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { JobCancelledError } from "../jobs/failure";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import type { PhaseContext, PhaseEventInput } from "./phase-context";
import { planningPhase } from "./planning-phase";

/**
 * A phase whose entire contract is "one event, no side effects".
 *
 * Small, but worth having: the failure mode this guards against is someone
 * later giving the body real work and leaving the `durationMs: 0` and the
 * "deferred" event in place, which would produce a timeline saying no plan was
 * made next to the plan.
 */

const JOB = { id: "11111111-2222-3333-4444-555555555555" } as unknown as JobDetail;

function harness() {
  const controller = new AbortController();
  const events: PhaseEventInput[] = [];

  const ctx: PhaseContext = {
    job: JOB,
    phase: { status: "planning", label: "Create plan", durationMs: 0 },
    sandboxes: new SandboxHolder(),
    signal: controller.signal,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },

    // Everything this phase must not do. The sandbox holder is empty for the
    // same reason: `planning` runs before anything needs a container of its own.
    exec: () => Promise.reject(new Error("the planning phase runs no commands")),
    artifact: () => Promise.reject(new Error("a plan artifact is Milestone 6")),

    readBaseline: () => Promise.resolve(null),
    readSummary: () => Promise.reject(new Error("there is no session to summarize yet")),
    readValidation: () => Promise.reject(new Error("nothing has been validated yet")),
    recordProvisioning: () => Promise.reject(new Error("the planning phase writes no job columns")),
    recordAgentUsage: () => Promise.reject(new Error("the planning phase spends nothing")),

    event: (input) => {
      events.push(input);
      return Promise.resolve();
    },
  };

  return { run: () => planningPhase()(ctx), controller, events };
}

describe("planningPhase", () => {
  it("records exactly one plan.deferred event and nothing else", async () => {
    const test = harness();

    await test.run();

    expect(test.events).toHaveLength(1);
    expect(test.events[0]?.type).toBe("plan.deferred");
    expect(test.events[0]?.message.length).toBeGreaterThan(0);
  });

  it("stops on an aborted signal rather than writing to a job that ended", async () => {
    const test = harness();
    test.controller.abort(new JobCancelledError("cancelled while planning"));

    await expect(test.run()).rejects.toBeInstanceOf(JobCancelledError);
    expect(test.events).toEqual([]);
  });
});
