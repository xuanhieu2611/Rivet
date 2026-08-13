import { isTerminal } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { ALLOWED_TRANSITIONS } from "../jobs/transitions";
import { finalPhaseStatus, SIMULATED_PIPELINE } from "./phases";

/**
 * The pipeline and the guard table are two descriptions of the same lifecycle,
 * written in different files for different reasons. These tests are what stop
 * them disagreeing: reordering a phase or renaming a status fails here, on a
 * pure data structure, rather than halfway through a run against a database.
 */

describe("SIMULATED_PIPELINE", () => {
  it("starts at provisioning, which is where a claim leaves a job", () => {
    expect(SIMULATED_PIPELINE[0]?.status).toBe("provisioning");
  });

  it("visits each status at most once", () => {
    const statuses = SIMULATED_PIPELINE.map((phase) => phase.status);
    expect(new Set(statuses).size).toBe(statuses.length);
  });

  it("never runs a phase in a terminal status", () => {
    for (const phase of SIMULATED_PIPELINE) {
      expect(isTerminal(phase.status)).toBe(false);
    }
  });

  it("forms a legal walk through ALLOWED_TRANSITIONS", () => {
    for (let index = 1; index < SIMULATED_PIPELINE.length; index += 1) {
      const from = SIMULATED_PIPELINE[index - 1]!.status;
      const to = SIMULATED_PIPELINE[index]!.status;
      expect(ALLOWED_TRANSITIONS[from], `${from} -> ${to}`).toContain(to);
    }
  });

  it("ends somewhere that can reach completed", () => {
    expect(ALLOWED_TRANSITIONS[finalPhaseStatus()]).toContain("completed");
  });

  it("can be abandoned from every phase", () => {
    // Cancellation and timeout can land on any phase, so every status the
    // pipeline passes through needs those edges or the abort path would throw
    // IllegalTransitionError instead of recording what happened.
    for (const phase of SIMULATED_PIPELINE) {
      expect(ALLOWED_TRANSITIONS[phase.status]).toContain("cancelled");
      expect(ALLOWED_TRANSITIONS[phase.status]).toContain("failed");
      expect(ALLOWED_TRANSITIONS[phase.status]).toContain("timed_out");
      // The release-on-shutdown and sweeper-reclaim path.
      expect(ALLOWED_TRANSITIONS[phase.status]).toContain("queued");
    }
  });

  it("gives every phase a positive duration and a label", () => {
    for (const phase of SIMULATED_PIPELINE) {
      expect(phase.durationMs).toBeGreaterThan(0);
      expect(phase.label.length).toBeGreaterThan(0);
    }
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
