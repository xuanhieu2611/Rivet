import { jobs, type Database } from "@rivet/database";
import { describe, expect, it, vi } from "vitest";

import { recordAgentUsage } from "./agent-usage";

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

describe("recordAgentUsage", () => {
  it("writes the totals through a lease-fenced update", async () => {
    const test = databaseReturning([{ id: JOB_ID }]);
    const patch = {
      totalInputTokens: 1_000,
      totalOutputTokens: 200,
      totalCostUsd: "0.2500",
    };

    await expect(recordAgentUsage(JOB_ID, LEASE_OWNER, patch, test.database)).resolves.toBe(true);

    expect(test.update).toHaveBeenCalledWith(jobs);
    expect(test.set).toHaveBeenCalledWith(patch);
    expect(test.where).toHaveBeenCalledOnce();
    expect(test.returning).toHaveBeenCalledWith({ id: jobs.id });
  });

  it("reports a lost lease when the fenced update matches nothing", async () => {
    const test = databaseReturning([]);

    await expect(
      recordAgentUsage(
        JOB_ID,
        LEASE_OWNER,
        { totalInputTokens: 1, totalOutputTokens: 2 },
        test.database,
      ),
    ).resolves.toBe(false);
  });

  it("treats an empty patch as a safe no-op", async () => {
    const test = databaseReturning([]);

    await expect(recordAgentUsage(JOB_ID, LEASE_OWNER, {}, test.database)).resolves.toBe(true);
    expect(test.update).not.toHaveBeenCalled();
  });
});
