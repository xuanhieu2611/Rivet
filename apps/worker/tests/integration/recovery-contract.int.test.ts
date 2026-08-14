import { describe, expect, it } from "vitest";

import { MILESTONE_6_RECOVERY_EVENT_SEQUENCE, recoveryEventKey } from "./support";

/**
 * Stage 0 deliberately lands before the M6 schema and pipeline work.
 *
 * The TODO is the north-star worker-crash run. It becomes executable once the
 * later stages provide plan, checkpoint and generation persistence. Keeping the
 * trace and its detailed keying in `support.ts` now prevents those stages from
 * quietly proving a simpler "retry from provisioning" workflow instead.
 */
describe("Milestone 6 recovery acceptance contract", () => {
  it("records the phase, attempt, generation and checkpoint distinctions", () => {
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE[0]).toBe("job.created");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("job.claimed:attempt-1");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("job.claimed:attempt-2");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("job.enqueued:generation-0");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("job.enqueued:generation-1");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("checkpoint.created:phase_boundary");
    expect(MILESTONE_6_RECOVERY_EVENT_SEQUENCE).toContain("checkpoint.created:agent_turn");
    expect(
      MILESTONE_6_RECOVERY_EVENT_SEQUENCE.filter(
        (entry) => entry === "phase.started:Establish test baseline",
      ),
    ).toHaveLength(1);
    expect(
      MILESTONE_6_RECOVERY_EVENT_SEQUENCE.filter((entry) => entry === "phase.started:Create plan"),
    ).toHaveLength(1);
  });

  it("keys phase and generation details without depending on future contracts", () => {
    expect(
      recoveryEventKey({
        type: "phase.started",
        data: { phase: "Provision sandbox" },
      }),
    ).toBe("phase.started:Provision sandbox");
    expect(
      recoveryEventKey({
        type: "job.claimed",
        data: { attempt: 2 },
      }),
    ).toBe("job.claimed:attempt-2");
    expect(
      recoveryEventKey({
        type: "job.enqueued",
        data: { dispatchGeneration: 1 },
      }),
    ).toBe("job.enqueued:generation-1");
  });

  it.todo(
    "recovers a killed implementing worker from its plan and checkpoint, then validates and completes",
  );
});
