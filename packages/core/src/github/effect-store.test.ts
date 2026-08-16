import type { Executor, JobExternalEffectRow, NewJobExternalEffectRow } from "@rivet/database";
import { describe, expect, it } from "vitest";

import { recordExternalEffect } from "./effect-store";

const JOB_ID = "11111111-2222-3333-4444-555555555555";

function rowFrom(values: NewJobExternalEffectRow): JobExternalEffectRow {
  return {
    id: 7,
    createdAt: new Date(0),
    ...values,
  } as JobExternalEffectRow;
}

function capturingExecutor(options: { inserted?: boolean; existing?: JobExternalEffectRow } = {}) {
  const values: NewJobExternalEffectRow[] = [];
  const executor = {
    insert: () => ({
      values: (value: NewJobExternalEffectRow) => {
        values.push(value);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(options.inserted === false ? [] : [rowFrom(value)]),
          }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(options.existing ? [options.existing] : []),
        }),
      }),
    }),
  } as unknown as Executor;

  return { executor, values };
}

describe("recordExternalEffect", () => {
  it("writes a GitHub receipt and maps it to the external-effect contract", async () => {
    const capture = capturingExecutor();

    const effect = await recordExternalEffect(
      {
        jobId: JOB_ID,
        kind: "branch_pushed",
        externalId: "commit-sha",
        externalUrl: "https://github.com/acme/widgets/tree/rivet/job",
        payload: { treeSha: "tree-sha", adopted: false },
      },
      capture.executor,
    );

    expect(capture.values).toEqual([
      {
        jobId: JOB_ID,
        kind: "branch_pushed",
        provider: "github",
        externalId: "commit-sha",
        externalUrl: "https://github.com/acme/widgets/tree/rivet/job",
        payload: { treeSha: "tree-sha", adopted: false },
      },
    ]);
    expect(effect).toEqual({
      id: 7,
      jobId: JOB_ID,
      kind: "branch_pushed",
      provider: "github",
      externalId: "commit-sha",
      externalUrl: "https://github.com/acme/widgets/tree/rivet/job",
      payload: { treeSha: "tree-sha", adopted: false },
      createdAt: new Date(0),
    });
  });

  it("returns the durable row when the receipt already exists", async () => {
    const existing = rowFrom({
      jobId: JOB_ID,
      kind: "pull_request_opened",
      provider: "github",
      externalId: "pr-node-id",
      externalUrl: "https://github.com/acme/widgets/pull/17",
      payload: { number: 17 },
    });
    const capture = capturingExecutor({ inserted: false, existing });

    const effect = await recordExternalEffect(
      {
        jobId: JOB_ID,
        kind: "pull_request_opened",
        provider: "github",
        externalId: "a-new-value",
        externalUrl: "https://example.test/should-not-replace",
      },
      capture.executor,
    );

    expect(effect).toEqual({
      id: 7,
      jobId: JOB_ID,
      kind: "pull_request_opened",
      provider: "github",
      externalId: "pr-node-id",
      externalUrl: "https://github.com/acme/widgets/pull/17",
      payload: { number: 17 },
      createdAt: new Date(0),
    });
  });

  it("does not claim a conflict when the existing row cannot be read", async () => {
    const capture = capturingExecutor({ inserted: false });

    await expect(
      recordExternalEffect(
        {
          jobId: JOB_ID,
          kind: "branch_pushed",
          externalId: "commit-sha",
          externalUrl: "https://github.com/acme/widgets/tree/rivet/job",
        },
        capture.executor,
      ),
    ).rejects.toThrow(/conflicted but no existing row/);
  });
});
