import type { ExternalEffect } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { decideReconciliation, type ReconcileInput } from "./reconcile";

const RECEIPT: ExternalEffect = {
  id: 1,
  jobId: "11111111-2222-3333-4444-555555555555",
  kind: "branch_pushed",
  provider: "github",
  externalId: "remote-commit",
  externalUrl: "https://github.com/acme/widgets/tree/rivet/job",
  payload: null,
  createdAt: new Date("2026-08-14T00:00:00.000Z"),
};

const REMOTE = { commitSha: "remote-commit", treeSha: "tree-a" };

describe("decideReconciliation", () => {
  it.each([
    ["no receipt and no ref", null, null, "tree-a", "push"],
    ["receipt and no ref", RECEIPT, null, "tree-a", "push"],
    ["no receipt and matching ref", null, REMOTE, "tree-a", "adopt"],
    ["receipt and matching ref", RECEIPT, REMOTE, "tree-a", "adopt"],
    ["no receipt and changed ref", null, REMOTE, "tree-b", "force_push"],
    ["receipt and changed ref", RECEIPT, REMOTE, "tree-b", "force_push"],
  ] as const)("returns %s", (_name, receipt, remoteRef, desiredTreeSha, expected) => {
    const input: ReconcileInput = { receipt, remoteRef, desiredTreeSha };
    expect(decideReconciliation(input)).toBe(expected);
  });

  it("supports the positional form used by small callers", () => {
    expect(decideReconciliation(null, REMOTE, "tree-a")).toBe("adopt");
  });
});
