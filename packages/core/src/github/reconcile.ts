import type { ExternalEffect } from "@rivet/contracts";

import type { RefState } from "./github";

/** What the publication phase must do after it inspects the provider. */
export type ReconcileAction = "adopt" | "push" | "force_push";

export interface ReconcileInput {
  /** The durable receipt for the branch push, if one was committed. */
  receipt: ExternalEffect | null;
  /** The current remote branch ref, if it exists. */
  remoteRef: RefState | null;
  /** The tree produced by the validated local workspace. */
  desiredTreeSha: string;
}

/**
 * Decides whether a publication effect can be adopted or has to be performed.
 *
 * Commits are intentionally not compared here. Their metadata includes a
 * timestamp and therefore changes when a replacement worker reconstructs the
 * same tree. A matching remote tree is the durable fact that makes adoption
 * safe. A receipt without a ref is stale, while a ref without a receipt is the
 * crash window this protocol is designed to recover from.
 */
export function decideReconciliation(input: ReconcileInput): ReconcileAction;
export function decideReconciliation(
  receipt: ExternalEffect | null,
  remoteRef: RefState | null,
  desiredTreeSha: string,
): ReconcileAction;
export function decideReconciliation(
  inputOrReceipt: ReconcileInput | ExternalEffect | null,
  remoteRefArgument?: RefState | null,
  desiredTreeShaArgument?: string,
): ReconcileAction {
  const input: ReconcileInput =
    inputOrReceipt !== null && isReconcileInput(inputOrReceipt)
      ? inputOrReceipt
      : {
          receipt: inputOrReceipt,
          remoteRef: remoteRefArgument ?? null,
          desiredTreeSha: desiredTreeShaArgument ?? "",
        };

  if (input.remoteRef === null) return "push";
  if (input.remoteRef.treeSha === input.desiredTreeSha) return "adopt";
  return "force_push";
}

/** Shorter alias for callers that already have the reconciliation context. */
export const decideReconcile = decideReconciliation;
/** Alias that names the returned value rather than the protocol step. */
export const reconcilePublication = decideReconciliation;

function isReconcileInput(value: ExternalEffect | ReconcileInput): value is ReconcileInput {
  return "remoteRef" in value && "desiredTreeSha" in value;
}
