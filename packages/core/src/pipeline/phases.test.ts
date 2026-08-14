import { isTerminal } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import type { CodingAgent } from "../agent/coding-agent";
import { ALLOWED_TRANSITIONS } from "../jobs/transitions";
import type { SandboxProvider } from "../sandbox/sandbox";
import {
  buildPipeline,
  finalPhaseStatus,
  type Phase,
  type PipelineOptions,
  simulatedPipeline,
} from "./phases";

/**
 * The pipeline and the guard table are two descriptions of the same lifecycle,
 * written in different files for different reasons. These tests are what stop
 * them disagreeing: reordering a phase or renaming a status fails here, on a
 * pure data structure, rather than halfway through a run against a database.
 *
 * Every structural rule is checked against **both** pipelines. A real phase and
 * a simulated one differ in what they do and in nothing else, and the moment
 * that stops being true the sandbox pipeline can walk a path the simulated one
 * never proved legal.
 */

/** Enough of a provider to build a pipeline; nothing here ever runs a phase. */
const STUB_PROVIDER: SandboxProvider = {
  create: () => Promise.reject(new Error("not used")),
  reap: () => Promise.resolve([]),
};

/** Enough of a harness to build a pipeline; nothing here ever starts a session. */
const STUB_AGENT: CodingAgent = {
  start: () => Promise.reject(new Error("not used")),
};

const SANDBOX_OPTIONS: PipelineOptions = {
  sandbox: STUB_PROVIDER,
  image: "node@sha256:deadbeef",
  workdir: "/home/node/workspace",
  memoryBytes: 2_147_483_648,
  nanoCpus: 2_000_000_000,
  pidsLimit: 512,
  commandTimeoutMs: 120_000,
  cloneTimeoutMs: 180_000,
  installTimeoutMs: 300_000,
  baselineTimeoutMs: 300_000,
  diffMaxBytes: 1_048_576,
};

const PIPELINES: Record<string, readonly Phase[]> = {
  simulated: simulatedPipeline(),
  sandbox: buildPipeline(SANDBOX_OPTIONS),
};

describe.each(Object.entries(PIPELINES))("%s pipeline", (_name, phases) => {
  it("starts at provisioning, which is where a claim leaves a job", () => {
    expect(phases[0]?.status).toBe("provisioning");
  });

  it("visits each status at most once", () => {
    const statuses = phases.map((phase) => phase.status);
    expect(new Set(statuses).size).toBe(statuses.length);
  });

  it("never runs a phase in a terminal status", () => {
    for (const phase of phases) {
      expect(isTerminal(phase.status)).toBe(false);
    }
  });

  it("forms a legal walk through ALLOWED_TRANSITIONS", () => {
    for (let index = 1; index < phases.length; index += 1) {
      const from = phases[index - 1]!.status;
      const to = phases[index]!.status;
      expect(ALLOWED_TRANSITIONS[from], `${from} -> ${to}`).toContain(to);
    }
  });

  it("ends somewhere that can reach completed", () => {
    expect(ALLOWED_TRANSITIONS[finalPhaseStatus(phases)]).toContain("completed");
  });

  it("can be abandoned from every phase", () => {
    // Cancellation and timeout can land on any phase, so every status the
    // pipeline passes through needs those edges or the abort path would throw
    // IllegalTransitionError instead of recording what happened.
    for (const phase of phases) {
      expect(ALLOWED_TRANSITIONS[phase.status]).toContain("cancelled");
      expect(ALLOWED_TRANSITIONS[phase.status]).toContain("failed");
      expect(ALLOWED_TRANSITIONS[phase.status]).toContain("timed_out");
      // The release-on-shutdown and sweeper-reclaim path.
      expect(ALLOWED_TRANSITIONS[phase.status]).toContain("queued");
    }
  });

  it("gives every phase a label, and a sleep only where a sleep is honest", () => {
    for (const phase of phases) {
      expect(phase.label.length).toBeGreaterThan(0);
      // `planning` is the deliberate zero: Milestone 5 replaced its two-second
      // sleep with an event saying no plan was made, and a phase that announces
      // it did nothing must not also spend two seconds appearing to work. Every
      // other simulated phase still stands in for work a later milestone does,
      // so a zero there would be a phase that had quietly stopped existing.
      if (phase.status === "planning") {
        expect(phase.durationMs).toBe(0);
      } else {
        expect(phase.durationMs).toBeGreaterThan(0);
      }
    }
  });

  it("holds the same statuses and labels as every other pipeline", () => {
    expect(phases.map((phase) => [phase.status, phase.label])).toEqual(
      simulatedPipeline().map((phase) => [phase.status, phase.label]),
    );
  });
});

describe("simulatedPipeline", () => {
  it("has no real work in it at all", () => {
    // The `RIVET_SANDBOX=off` path. A body appearing here would mean the
    // integration suite quietly started needing a Docker daemon.
    expect(simulatedPipeline().filter((phase) => phase.run)).toEqual([]);
  });

  it("hands out a fresh list each call, so a caller cannot edit the template", () => {
    const first = simulatedPipeline();
    const second = simulatedPipeline();
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
  });
});

describe("buildPipeline", () => {
  it("makes provisioning, analyzing and planning real and leaves the rest simulated", () => {
    const real = PIPELINES.sandbox!.filter((phase) => phase.run).map((phase) => phase.status);
    // In pipeline order, which is also the assertion that the baseline moved:
    // it is `analyzing` that does real work now. `implementing` and `testing`
    // are both absent because this pipeline was built without an agent. This
    // list is how a phase quietly acquiring a body gets noticed.
    expect(real).toEqual(["provisioning", "analyzing", "planning"]);
  });

  it("makes implementing, testing and finalizing real together, and only with an agent", () => {
    // The grouping is the point. Validation's first act is to fail a job whose
    // diff is empty, which is the right answer for a session that changed
    // nothing and the wrong one for a pipeline that never had a session - and
    // `finalizing` has nothing to summarize when neither of the phases that
    // produce its two outputs ran. So a build with a harness gets all three
    // bodies, and a build without gets none of them.
    const withAgent = buildPipeline({
      ...SANDBOX_OPTIONS,
      agent: {
        coding: STUB_AGENT,
        sessionTimeoutMs: 900_000,
        maxTurns: 40,
        previewMaxBytes: 2_048,
        fileMaxBytes: 262_144,
      },
    });

    expect(withAgent.filter((phase) => phase.run).map((phase) => phase.status)).toEqual([
      "provisioning",
      "analyzing",
      "planning",
      "implementing",
      "testing",
      "finalizing",
    ]);
  });

  it("does not share phase objects with the simulated pipeline", () => {
    const sandboxProvisioning = PIPELINES.sandbox![0];
    const simulatedProvisioning = simulatedPipeline()[0];
    expect(sandboxProvisioning?.run).toBeDefined();
    expect(simulatedProvisioning?.run).toBeUndefined();
  });
});

describe("finalPhaseStatus", () => {
  it("is the last phase's status", () => {
    expect(finalPhaseStatus()).toBe("finalizing");
  });

  it("refuses an empty pipeline rather than returning undefined", () => {
    expect(() => finalPhaseStatus([])).toThrow(/at least one phase/);
  });
});
