import { jobs, type Database } from "@rivet/database";
import { describe, expect, it, vi } from "vitest";

import { recordReview } from "./review";

const JOB_ID = "11111111-2222-3333-4444-555555555555";
const LEASE_OWNER = "worker-1";

function databaseReturning(rows: readonly { id: string }[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });

  return {
    database: { update } as unknown as Database,
    update,
    set,
    where,
    returning,
  };
}

describe("recordReview", () => {
  it("writes review accounting through a lease-fenced update", async () => {
    const test = databaseReturning([{ id: JOB_ID }]);
    const patch = {
      reviewDecision: "revise" as const,
      reviewLoops: 1,
      reviewBlockingCount: 2,
    };

    await expect(recordReview(JOB_ID, LEASE_OWNER, patch, test.database)).resolves.toBe(true);

    expect(test.update).toHaveBeenCalledWith(jobs);
    expect(test.set).toHaveBeenCalledWith(patch);
    expect(test.where).toHaveBeenCalledOnce();
    expect(test.returning).toHaveBeenCalledWith({ id: jobs.id });
  });

  it("reports a lost lease when the fenced update matches nothing", async () => {
    const test = databaseReturning([]);

    await expect(
      recordReview(
        JOB_ID,
        LEASE_OWNER,
        { reviewDecision: "approve", reviewLoops: 0, reviewBlockingCount: 0 },
        test.database,
      ),
    ).resolves.toBe(false);
  });

  it("treats an empty patch as a safe no-op", async () => {
    const test = databaseReturning([]);

    await expect(recordReview(JOB_ID, LEASE_OWNER, {}, test.database)).resolves.toBe(true);
    expect(test.update).not.toHaveBeenCalled();
  });
});
