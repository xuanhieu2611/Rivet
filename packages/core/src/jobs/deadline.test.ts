import { describe, expect, it } from "vitest";

import { isJobExpired, jobDeadline, remainingJobMinutes, remainingJobMs } from "./deadline";
import type { JobDetail } from "@rivet/contracts";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const CLAIMED = new Date("2026-08-14T11:30:00.000Z");

const facts = (overrides: Partial<JobDetail> = {}) =>
  ({
    deadlineAt: null,
    startedAt: null,
    maxDurationSeconds: 3_600,
    ...overrides,
  }) as JobDetail;

describe("jobDeadline", () => {
  it("uses the durable deadline whenever there is one", () => {
    const deadline = new Date("2026-08-14T12:30:00.000Z");

    expect(jobDeadline(facts({ deadlineAt: deadline, startedAt: CLAIMED }))).toEqual(deadline);
  });

  it("falls back to the budget counted from the first start", () => {
    // Rows claimed before `deadline_at` existed keep the budget they always had
    // rather than becoming unbounded.
    expect(jobDeadline(facts({ startedAt: CLAIMED }))).toEqual(
      new Date("2026-08-14T12:30:00.000Z"),
    );
  });

  it("has no deadline before anything has started", () => {
    expect(jobDeadline(facts())).toBeNull();
  });
});

describe("remainingJobMs", () => {
  it("returns what is left of a durable deadline", () => {
    const job = facts({ deadlineAt: new Date("2026-08-14T12:30:00.000Z") });

    expect(remainingJobMs(job, NOW)).toBe(30 * 60_000);
  });

  it("never goes negative", () => {
    const job = facts({ deadlineAt: new Date("2026-08-14T10:00:00.000Z") });

    expect(remainingJobMs(job, NOW)).toBe(0);
    expect(isJobExpired(job, NOW)).toBe(true);
  });

  it("gives an unclaimed job its whole configured budget", () => {
    expect(remainingJobMs(facts({ maxDurationSeconds: 60 }), NOW)).toBe(60_000);
    expect(isJobExpired(facts(), NOW)).toBe(false);
  });

  it("does not extend the budget for a reclaimed attempt", () => {
    // The whole reason the column exists: the second claim of a job that has
    // been running for half an hour gets half an hour, not another one.
    const job = facts({
      deadlineAt: new Date("2026-08-14T12:30:00.000Z"),
      startedAt: CLAIMED,
    });

    expect(remainingJobMs(job, NOW)).toBeLessThan(job.maxDurationSeconds * 1_000);
  });
});

describe("remainingJobMinutes", () => {
  it("rounds to whole minutes for the recovery prompt", () => {
    const job = facts({ deadlineAt: new Date("2026-08-14T12:29:40.000Z") });

    expect(remainingJobMinutes(job, NOW)).toBe(30);
  });

  it("is null rather than a number when nothing has started the clock", () => {
    // Null and zero are different facts: one is "no time left", the other is
    // "nobody has started this job", and the prompt omits the line entirely.
    expect(remainingJobMinutes(facts(), NOW)).toBeNull();
  });
});
