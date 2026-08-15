import type { JobEvent, JobEventData, JobEventType } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { describeRecoveryEvent, isRecoveryEvent } from "@/lib/recovery-events";

function event(type: JobEventType, data: JobEventData | null, message = "message"): JobEvent {
  return {
    id: 1,
    jobId: "11111111-1111-4111-8111-111111111111",
    type,
    message,
    data,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("isRecoveryEvent", () => {
  it("recognizes the planning and recovery vocabulary", () => {
    for (const type of [
      "plan.recorded",
      "checkpoint.created",
      "checkpoint.restored",
      "checkpoint.rejected",
      "run.resumed",
      "job.reclaimed",
    ] as const) {
      expect(isRecoveryEvent(event(type, null))).toBe(true);
    }
  });

  it("leaves ordinary events to the generic presentation", () => {
    expect(isRecoveryEvent(event("phase.started", { phase: "implementing" }))).toBe(false);
    expect(describeRecoveryEvent(event("phase.started", { phase: "implementing" }))).toBeNull();
  });
});

describe("describeRecoveryEvent", () => {
  it("describes an agent-turn checkpoint by the boundary it captured", () => {
    const presentation = describeRecoveryEvent(
      event("checkpoint.created", {
        checkpointId: 7,
        checkpointSequence: 3,
        checkpointKind: "agent_turn",
        resumePhase: "implementing",
        attempt: 1,
        turn: 2,
        sandboxId: "abcdef0123456789",
        patchByteSize: 2_048,
        patchCompressedBytes: 512,
        filesChanged: 2,
        insertions: 10,
        deletions: 3,
      }),
    );

    expect(presentation?.label).toBe("Checkpoint 3");
    expect(presentation?.emphasis).toBe("neutral");
    expect(presentation?.facts).toEqual([
      "agent turn",
      "resumes at Implementing",
      "after turn 2",
      "attempt 1",
      "2.0 KB patch (512 B stored)",
      "2 files, +10/-3",
      "sandbox abcdef012345",
    ]);
  });

  it("reads a phase boundary as the two phases it sits between", () => {
    const presentation = describeRecoveryEvent(
      event("checkpoint.created", {
        checkpointSequence: 1,
        checkpointKind: "phase_boundary",
        completedPhase: "analyzing",
        resumePhase: "planning",
        filesChanged: 0,
      }),
    );

    expect(presentation?.facts).toEqual([
      "phase boundary",
      "Analyzing -> Planning",
      "no workspace changes",
    ]);
    expect(presentation?.explanation).toContain("instead of repeating this one");
  });

  it("accepts the column-named checkpoint aliases", () => {
    const presentation = describeRecoveryEvent(
      event("checkpoint.created", { sequence: 4, kind: "agent_turn", resumePhase: "implementing" }),
    );

    expect(presentation?.label).toBe("Checkpoint 4");
    expect(presentation?.facts[0]).toBe("agent turn");
  });

  it("states the container change that proves a restore rebuilt the environment", () => {
    const presentation = describeRecoveryEvent(
      event("checkpoint.restored", {
        checkpointSequence: 3,
        checkpointKind: "agent_turn",
        resumePhase: "implementing",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        originalSandboxId: "aaaaaaaaaaaaaaaa",
        replacementSandboxId: "bbbbbbbbbbbbbbbb",
        sandboxId: "bbbbbbbbbbbbbbbb",
        patchSha256: "deadbeef",
        patchByteSize: 900,
        turn: 2,
      }),
    );

    expect(presentation?.emphasis).toBe("positive");
    expect(presentation?.facts).toEqual([
      "sandbox aaaaaaaaaaaa -> bbbbbbbbbbbb",
      "base 0123456789ab",
      "after turn 2",
      "resumes at Implementing",
      "900 B patch",
      "checksum verified",
    ]);
  });

  it("reports a rejected checkpoint in the failure taxonomy's own words", () => {
    const presentation = describeRecoveryEvent(
      event("checkpoint.rejected", {
        checkpointSequence: 2,
        failureCategory: "checkpoint_restore_failed",
        error: "patch does not apply",
        argv: ["git", "apply", "--binary", "patch"],
      }),
    );

    expect(presentation?.emphasis).toBe("negative");
    expect(presentation?.facts).toEqual(["Checkpoint restore failed", "git apply --binary patch"]);
    expect(presentation?.explanation).toContain("rather than quietly starting over");
  });

  it("says where a resumed run continues and under which generation", () => {
    const presentation = describeRecoveryEvent(
      event("run.resumed", {
        checkpointSequence: 3,
        resumePhase: "implementing",
        attempt: 2,
        dispatchGeneration: 1,
      }),
    );

    expect(presentation?.label).toBe("Resumed");
    expect(presentation?.facts).toEqual([
      "continues at Implementing",
      "checkpoint 3",
      "attempt 2",
      "generation 1",
    ]);
  });

  it("names the worker a reclaim took the job from", () => {
    const presentation = describeRecoveryEvent(
      event("job.reclaimed", { leaseOwner: "worker-a", attempt: 1, dispatchGeneration: 1 }),
    );

    expect(presentation?.facts).toEqual(["previous owner worker-a", "attempt 1", "generation 1"]);
  });

  it("points a recorded plan at its artifact", () => {
    const presentation = describeRecoveryEvent(
      event("plan.recorded", { artifactId: 12, agentRole: "planner" }),
    );

    expect(presentation?.label).toBe("Plan");
    expect(presentation?.facts).toEqual(["artifact #12", "planner session"]);
  });

  it("renders an event with no structured data without inventing facts", () => {
    const presentation = describeRecoveryEvent(event("checkpoint.created", null));

    expect(presentation?.label).toBe("Checkpoint");
    expect(presentation?.facts).toEqual([]);
  });
});
