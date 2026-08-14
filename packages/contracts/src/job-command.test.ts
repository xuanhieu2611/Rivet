import { describe, expect, it } from "vitest";

import {
  parseSerializedJobCommand,
  parseSerializedJobCommandSummary,
  serializeJobCommand,
  serializeJobCommandSummary,
  type JobCommand,
  type JobCommandSummary,
} from "./job-command";

const SUMMARY: JobCommandSummary = {
  id: 7,
  jobId: "11111111-2222-3333-8444-555555555555",
  phase: "testing",
  argv: ["pnpm", "test"],
  cwd: "/home/node/workspace/repo",
  exitCode: 0,
  durationMs: 1_250,
  truncated: false,
  timedOut: false,
  oomKilled: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const COMMAND: JobCommand = {
  ...SUMMARY,
  stdout: "passed",
  stderr: "",
};

describe("serialized job commands", () => {
  it("serializes and restores summary dates", () => {
    const serialized = serializeJobCommandSummary(SUMMARY);

    expect(serialized.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(parseSerializedJobCommandSummary(serialized)).toEqual(SUMMARY);
  });

  it("serializes and restores transcript dates and output", () => {
    const serialized = serializeJobCommand(COMMAND);

    expect(serialized.stdout).toBe("passed");
    expect(parseSerializedJobCommand(serialized)).toEqual(COMMAND);
  });

  it("rejects malformed ids, dates, phases, and transcript fields", () => {
    expect(() =>
      parseSerializedJobCommandSummary({ ...serializeJobCommandSummary(SUMMARY), id: 0 }),
    ).toThrow();
    expect(() =>
      parseSerializedJobCommandSummary({
        ...serializeJobCommandSummary(SUMMARY),
        createdAt: "not-a-date",
      }),
    ).toThrow();
    expect(() =>
      parseSerializedJobCommandSummary({
        ...serializeJobCommandSummary(SUMMARY),
        phase: "running",
      }),
    ).toThrow();
    expect(() =>
      parseSerializedJobCommand({ ...serializeJobCommand(COMMAND), stdout: 42 }),
    ).toThrow();
  });
});
