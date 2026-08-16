import type { ExternalEffect, ExternalEffectKind, ExternalEffectProvider } from "@rivet/contracts";
import {
  db,
  type Executor,
  type JobExternalEffectRow,
  jobExternalEffects,
  type NewJobExternalEffectRow,
} from "@rivet/database";
import { and, asc, eq } from "drizzle-orm";

import { assertActiveLease } from "../jobs/lease";

/**
 * The only writer of `job_external_effects`.
 *
 * External effects are acknowledged at most once per job and kind. A repeated
 * call returns the durable row already present rather than turning a harmless
 * replay into a unique-constraint error. The caller can therefore reconcile a
 * provider effect and persist its receipt in the same transaction as its audit
 * event.
 */
export interface RecordExternalEffectInput {
  jobId: string;
  kind: ExternalEffectKind;
  /** M9 currently has one provider; defaulting keeps the call site explicit about the effect. */
  provider?: ExternalEffectProvider;
  externalId: string;
  externalUrl: string;
  payload?: Record<string, unknown> | null;
  /** When present, the receipt is fenced to the worker's active job lease. */
  leaseOwner?: string;
}

/**
 * Inserts a receipt, or returns the existing receipt for the same job/kind.
 *
 * `DO NOTHING` rather than a no-op update preserves the append-only property of
 * the ledger. The follow-up read is safe after PostgreSQL resolves the unique
 * conflict and also works when the insert is participating in a caller's
 * transaction.
 */
export async function recordExternalEffect(
  input: RecordExternalEffectInput,
  executor: Executor = db,
): Promise<ExternalEffect> {
  // Keep the lease check and the conflict-aware insert in one transaction when
  // the caller uses the shared database handle. A replacement worker cannot
  // race a stale worker between those two operations.
  if (input.leaseOwner !== undefined && executor === db) {
    return db.transaction((tx) => recordExternalEffect(input, tx));
  }

  if (input.leaseOwner !== undefined) {
    await assertActiveLease(input.jobId, input.leaseOwner, executor);
  }

  const values: NewJobExternalEffectRow = {
    jobId: input.jobId,
    kind: input.kind,
    provider: input.provider ?? "github",
    externalId: input.externalId,
    externalUrl: input.externalUrl,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  };

  const [inserted] = await executor
    .insert(jobExternalEffects)
    .values(values)
    .onConflictDoNothing({
      target: [jobExternalEffects.jobId, jobExternalEffects.kind],
    })
    .returning();

  if (inserted) return toExternalEffect(inserted);

  const existing = await getExternalEffect(input.jobId, input.kind, executor);
  if (!existing) {
    // This should only be possible if the conflicting row was removed between
    // the insert and the read. Jobs cascade their receipts and receipts are
    // otherwise append-only, so hiding that state would make reconciliation
    // claim an acknowledgement that Postgres cannot show us.
    throw new Error(
      `External effect ${input.jobId}/${input.kind} conflicted but no existing row was found.`,
    );
  }
  return existing;
}

/** Reads one receipt by its durable per-job idempotency key. */
export async function getExternalEffect(
  jobId: string,
  kind: ExternalEffectKind,
  executor: Executor = db,
): Promise<ExternalEffect | null> {
  const [row] = await executor
    .select()
    .from(jobExternalEffects)
    .where(and(eq(jobExternalEffects.jobId, jobId), eq(jobExternalEffects.kind, kind)))
    .limit(1);

  return row ? toExternalEffect(row) : null;
}

/** Reads all receipts for one job in creation order. */
export async function listExternalEffects(
  jobId: string,
  executor: Executor = db,
): Promise<ExternalEffect[]> {
  const rows = await executor
    .select()
    .from(jobExternalEffects)
    .where(eq(jobExternalEffects.jobId, jobId))
    .orderBy(asc(jobExternalEffects.id));

  return rows.map(toExternalEffect);
}

/** Maps the loose text columns to the contract consumed by the domain. */
export function toExternalEffect(row: JobExternalEffectRow): ExternalEffect {
  return {
    id: row.id,
    jobId: row.jobId,
    kind: row.kind as ExternalEffectKind,
    provider: row.provider as ExternalEffectProvider,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    payload: row.payload ?? null,
    createdAt: row.createdAt,
  };
}
