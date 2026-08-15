import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  checkpointKindSchema,
  checkpointPatchCompressionSchema,
  checkpointPatchFormatSchema,
  jobStatusSchema,
  type CheckpointKind,
  type CheckpointPatchCompression,
  type CheckpointPatchFormat,
  type JobStatus,
} from "@rivet/contracts";
import { db, type Executor, type JobCheckpointRow, jobCheckpoints, jobs } from "@rivet/database";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { appendEvent } from "../events/event-service";
import { CheckpointCorruptError, CheckpointTooLargeError, LeaseLostError } from "../jobs/failure";
import type { CheckpointPatchStats } from "./workspace-snapshot";

export { CheckpointCorruptError, CheckpointTooLargeError } from "../jobs/failure";
export type { CheckpointPatchStats } from "./workspace-snapshot";

/** The only checkpoint state schema supported by this version of Rivet. */
export const CHECKPOINT_STATE_VERSION = 1 as const;

const safeCheckpointReferenceSchema = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, "Checkpoint references must be safe integers.");

/**
 * The small, durable part of workflow state that belongs in a checkpoint.
 *
 * Patch metadata, usage, lease state and mutable job status deliberately do not
 * appear here. They have authoritative typed columns or their own durable
 * readers. Keeping this object small is what lets its version be a real
 * migration boundary rather than a second job record hidden in jsonb.
 */
export const checkpointStateV1Schema = z
  .object({
    version: z.literal(CHECKPOINT_STATE_VERSION),
    planArtifactId: safeCheckpointReferenceSchema.optional(),
    baselineEventId: safeCheckpointReferenceSchema.optional(),
    validationEventId: safeCheckpointReferenceSchema.optional(),
  })
  .strict();

export type CheckpointStateV1 = z.infer<typeof checkpointStateV1Schema>;

/** The state union is versioned so a future reader can dispatch explicitly. */
export const checkpointStateSchema = checkpointStateV1Schema;

/** A checkpoint's original bytes, ready to upload into a replacement sandbox. */
export type RestorePatch = Uint8Array;

/**
 * A validated checkpoint with its gzip payload decompressed and verified.
 *
 * `patch` and `restorePatch` intentionally point at the same logical bytes.
 * The shorter name is convenient for store callers; the explicit alias makes
 * recovery code read like the operation it is about to perform.
 */
export interface JobCheckpoint {
  id: number;
  jobId: string;
  sequence: number;
  attemptCount: number;
  kind: CheckpointKind;
  completedPhase: JobStatus | null;
  resumePhase: JobStatus;
  agentTurn: number | null;
  baseCommitSha: string;
  sandboxId: string;
  envFingerprint: Record<string, unknown>;
  state: CheckpointStateV1;
  patchFormat: CheckpointPatchFormat;
  patchCompression: CheckpointPatchCompression;
  patchSha256: string;
  patchByteSize: number;
  patchCompressedBytes: number;
  patch: RestorePatch;
  restorePatch: RestorePatch;
  createdAt: Date;
}

/** What a phase hands to the context capability after capturing its workspace. */
export interface RecordCheckpointInput {
  jobId: string;
  attemptCount: number;
  kind: CheckpointKind;
  completedPhase?: JobStatus | null;
  /** Optional assertion. The store derives it when omitted. */
  resumePhase?: JobStatus;
  agentTurn?: number | null;
  baseCommitSha: string;
  sandboxId: string;
  envFingerprint: Record<string, unknown>;
  state: unknown;
  /** Uncompressed, lossless Git patch bytes relative to `baseCommitSha`. */
  patch: Uint8Array;
  /** Patch totals computed before persistence, for checkpoint observability. */
  patchStats?: CheckpointPatchStats;
  /** Required policy supplied by the worker, not owned by core. */
  maxBytes: number;
  /** The fencing token. Checkpoints are never written without an active lease. */
  leaseOwner: string;
  patchFormat?: CheckpointPatchFormat;
  patchCompression?: CheckpointPatchCompression;
}

/** Bounds used when reading a checkpoint payload from Postgres. */
export interface CheckpointReadOptions {
  /** Maximum uncompressed bytes accepted from the gzip stream. */
  maxBytes?: number;
}

/** The supported patch protocol is intentionally fixed in M6. */
export const CHECKPOINT_PATCH_FORMAT: CheckpointPatchFormat = "git_binary_full_index";
export const CHECKPOINT_PATCH_COMPRESSION: CheckpointPatchCompression = "gzip";

/**
 * The phase order used by the durable workflow cursor.
 *
 * `revising` is included even though the base pipeline does not list it; it is
 * reached through a review directive and must remain a legal recovery cursor.
 */
export const CHECKPOINT_PHASE_ORDER = [
  "provisioning",
  "analyzing",
  "planning",
  "implementing",
  "testing",
  "reviewing",
  "revising",
  "finalizing",
] as const satisfies readonly JobStatus[];

const NEXT_PHASE: Partial<Record<JobStatus, JobStatus>> = {
  provisioning: "analyzing",
  analyzing: "planning",
  planning: "implementing",
  implementing: "testing",
  testing: "reviewing",
  reviewing: "finalizing",
  revising: "testing",
};

/** Returns the next resumable phase after a completed phase, or null at the end. */
export function nextPhaseAfter(completedPhase: JobStatus): JobStatus | null {
  return NEXT_PHASE[completedPhase] ?? null;
}

/** Alias that reads naturally at call sites that are selecting a cursor. */
export const resumePhaseAfter = nextPhaseAfter;
export const nextPhase = nextPhaseAfter;

/**
 * Derives the only legal resume phase for a checkpoint kind.
 *
 * An implementation turn does not complete a phase, so it always starts a
 * fresh implementation session. A phase boundary resumes the suffix after the
 * named phase. `finalizing` has no standalone checkpoint boundary because its
 * transition to `completed` is its durable acknowledgement.
 */
export function resumePhaseForCheckpoint(
  kind: CheckpointKind,
  completedPhase?: JobStatus | null,
  requestedResumePhase?: JobStatus,
): JobStatus {
  if (kind === "agent_turn") {
    if (completedPhase !== undefined && completedPhase !== null) {
      throw new Error("An agent-turn checkpoint cannot complete a phase.");
    }
    if (requestedResumePhase === undefined) return "implementing";
    if (requestedResumePhase !== "implementing" && requestedResumePhase !== "revising") {
      throw new Error(
        `An agent-turn checkpoint can resume only implementing or revising, not ${requestedResumePhase}.`,
      );
    }
    return requestedResumePhase;
  }

  if (completedPhase === undefined || completedPhase === null) {
    throw new Error("A phase-boundary checkpoint must name its completed phase.");
  }

  const defaultResumePhase = nextPhaseAfter(completedPhase);
  if (!defaultResumePhase) {
    throw new Error(`No resumable phase follows ${completedPhase}.`);
  }
  if (requestedResumePhase === undefined) return defaultResumePhase;

  const allowedResumePhases =
    completedPhase === "reviewing" ? ["finalizing", "revising"] : [defaultResumePhase];
  if (!allowedResumePhases.includes(requestedResumePhase)) {
    throw new Error(
      `A ${completedPhase} checkpoint can resume only ${allowedResumePhases.join(" or ")}, not ${requestedResumePhase}.`,
    );
  }
  return requestedResumePhase;
}

/** Checks a stored or caller-supplied resume phase against the checkpoint kind. */
export function isLegalCheckpointResume(
  kind: CheckpointKind,
  completedPhase: JobStatus | null | undefined,
  resumePhase: JobStatus,
): boolean {
  try {
    return resumePhaseForCheckpoint(kind, completedPhase, resumePhase) === resumePhase;
  } catch {
    return false;
  }
}

export const resumePhaseFor = resumePhaseForCheckpoint;
export const isLegalResumePhase = isLegalCheckpointResume;

/** Canonical SHA-256 over the uncompressed patch bytes. */
export function sha256CheckpointPatch(patch: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(patch)).digest("hex");
}

/** Alias used by callers that do not need to mention the checkpoint domain. */
export const sha256Patch = sha256CheckpointPatch;

/** Compresses a patch without changing its bytes or its checksum identity. */
export function compressCheckpointPatch(patch: Uint8Array): Buffer {
  return gzipSync(Buffer.from(patch));
}

/** Alias for the lower-level helper used in focused compression tests. */
export const gzipCheckpointPatch = compressCheckpointPatch;

/**
 * Decompresses a stored patch with an explicit output bound.
 *
 * `gunzipSync` supports `maxOutputLength` in Node 24. The bound is applied by
 * zlib while it expands the stream, rather than after an unbounded allocation.
 */
export function decompressCheckpointPatch(compressed: Uint8Array, maxBytes: number): Buffer {
  assertByteLimit(maxBytes);

  try {
    const patch = gunzipSync(Buffer.from(compressed), { maxOutputLength: maxBytes });
    if (patch.byteLength > maxBytes) {
      throw new CheckpointTooLargeError(
        `Checkpoint patch expanded to ${patch.byteLength} bytes, above the ${maxBytes}-byte limit.`,
      );
    }
    return patch;
  } catch (error) {
    if (error instanceof CheckpointTooLargeError) throw error;
    if (isOutputLimitError(error)) {
      throw new CheckpointTooLargeError(
        `Checkpoint patch exceeds the ${maxBytes}-byte decompression limit.`,
        { cause: error },
      );
    }
    throw new CheckpointCorruptError(
      `Checkpoint patch is not a valid gzip payload: ${describeError(error)}.`,
      { cause: error },
    );
  }
}

/**
 * Validates and normalizes the versioned state object.
 *
 * The version discriminator is inspected before parsing the concrete schema so
 * a future version fails explicitly instead of being mistaken for a malformed
 * v1 payload.
 */
export function parseCheckpointState(value: unknown): CheckpointStateV1 {
  const version = readVersion(value);
  if (version !== CHECKPOINT_STATE_VERSION) {
    throw new CheckpointCorruptError(
      `Unsupported checkpoint state version ${String(version)}; expected ${CHECKPOINT_STATE_VERSION}.`,
    );
  }

  const parsed = checkpointStateV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new CheckpointCorruptError(`Invalid checkpoint state: ${parsed.error.message}.`);
  }

  return {
    version: CHECKPOINT_STATE_VERSION,
    ...(parsed.data.planArtifactId === undefined
      ? {}
      : { planArtifactId: parsed.data.planArtifactId }),
    ...(parsed.data.baselineEventId === undefined
      ? {}
      : { baselineEventId: parsed.data.baselineEventId }),
    ...(parsed.data.validationEventId === undefined
      ? {}
      : { validationEventId: parsed.data.validationEventId }),
  };
}

/** Alias that makes the version dispatch visible to recovery callers. */
export const parseCheckpointStateJson = parseCheckpointState;

/** Serializes validated state with a stable key order for durable JSON values. */
export function serializeCheckpointState(value: unknown): string {
  return JSON.stringify(parseCheckpointState(value));
}

/**
 * Turns a database row into an independently restorable checkpoint.
 *
 * Validation happens before the row is exposed to recovery. A row with a bad
 * checksum, a stale byte count, an unsupported protocol or an illegal cursor is
 * corrupt, not a signal to restart from zero.
 */
export function toRestorableCheckpoint(
  row: JobCheckpointRow,
  options: CheckpointReadOptions = {},
): JobCheckpoint {
  const kind = parseCheckpointKind(row.kind);
  const patchFormat = parsePatchFormat(row.patchFormat);
  const patchCompression = parsePatchCompression(row.patchCompression);
  const completedPhase = parseNullableStatus(row.completedPhase, "completed_phase");
  const resumePhase = parseStatus(row.resumePhase, "resume_phase");
  const expectedResumePhase = safeResumePhase(kind, completedPhase, resumePhase);

  if (resumePhase !== expectedResumePhase) {
    throw new CheckpointCorruptError(
      `Checkpoint ${row.id} resumes at ${resumePhase}, but ${kind} requires ${expectedResumePhase}.`,
    );
  }

  const state = parseCheckpointState(row.stateJson);
  const patchPayload = asBytes(row.patchPayload);
  const patchByteSize = safeNonnegativeInteger(row.patchByteSize, "patch_byte_size");
  const patchCompressedBytes = safeNonnegativeInteger(
    row.patchCompressedBytes,
    "patch_compressed_bytes",
  );

  if (patchCompressedBytes !== patchPayload.byteLength) {
    throw new CheckpointCorruptError(
      `Checkpoint ${row.id} declares ${patchCompressedBytes} compressed bytes but stores ${patchPayload.byteLength}.`,
    );
  }

  const maxBytes = options.maxBytes ?? Math.max(patchByteSize, patchCompressedBytes);
  assertByteLimit(maxBytes);
  if (patchByteSize > maxBytes) {
    throw new CheckpointTooLargeError(
      `Checkpoint ${row.id} declares ${patchByteSize} bytes, above the ${maxBytes}-byte limit.`,
    );
  }
  if (patchCompressedBytes > maxBytes) {
    throw new CheckpointTooLargeError(
      `Checkpoint ${row.id} declares ${patchCompressedBytes} compressed bytes, above the ${maxBytes}-byte limit.`,
    );
  }

  const patch = decompressCheckpointPatch(patchPayload, maxBytes);
  if (patch.byteLength !== patchByteSize) {
    throw new CheckpointCorruptError(
      `Checkpoint ${row.id} declares ${patchByteSize} patch bytes but expands to ${patch.byteLength}.`,
    );
  }

  const patchSha256 = row.patchSha256;
  if (!/^[a-f0-9]{64}$/.test(patchSha256)) {
    throw new CheckpointCorruptError(`Checkpoint ${row.id} has an invalid SHA-256 checksum.`);
  }
  const actualSha256 = sha256CheckpointPatch(patch);
  if (actualSha256 !== patchSha256) {
    throw new CheckpointCorruptError(
      `Checkpoint ${row.id} checksum mismatch: expected ${patchSha256}, got ${actualSha256}.`,
    );
  }

  const id = safePositiveInteger(row.id, "id");
  const sequence = safePositiveInteger(row.sequence, "sequence");
  const attemptCount = safeNonnegativeInteger(row.attemptCount, "attempt_count");
  const agentTurn =
    row.agentTurn === null ? null : safeNonnegativeInteger(row.agentTurn, "agent_turn");
  assertCheckpointKindFields(kind, completedPhase, agentTurn);
  const baseCommitSha = nonEmptyString(row.baseCommitSha, "base_commit_sha");
  const sandboxId = nonEmptyString(row.sandboxId, "sandbox_id");
  const envFingerprint = parseJsonObject(row.envFingerprint, "env_fingerprint");

  const restorePatch = patch;
  return {
    id,
    jobId: row.jobId,
    sequence,
    attemptCount,
    kind,
    completedPhase,
    resumePhase,
    agentTurn,
    baseCommitSha,
    sandboxId,
    envFingerprint,
    state,
    patchFormat,
    patchCompression,
    patchSha256,
    patchByteSize,
    patchCompressedBytes,
    patch: restorePatch,
    restorePatch,
    createdAt: row.createdAt,
  };
}

/** Alias matching the row-to-domain naming used by the other stores. */
export const toJobCheckpoint = toRestorableCheckpoint;

/**
 * Persists one complete checkpoint and its timeline event atomically.
 *
 * The patch is compressed before the transaction starts, but the lease check,
 * sequence allocation, insert and event all share one transaction. A worker
 * that loses its lease cannot publish a patch after the replacement attempt has
 * started, and a transaction failure cannot leave a phase claiming progress it
 * did not durably acknowledge.
 */
export async function recordCheckpoint(
  input: RecordCheckpointInput,
  executor: Executor = db,
): Promise<JobCheckpoint> {
  validateRecordInput(input);

  const state = parseCheckpointState(input.state);
  const patch = Buffer.from(input.patch);
  const patchByteSize = patch.byteLength;
  if (patchByteSize > input.maxBytes) {
    throw new CheckpointTooLargeError(
      `Checkpoint patch is ${patchByteSize} bytes, above the ${input.maxBytes}-byte limit.`,
    );
  }

  const compressed = compressCheckpointPatch(patch);
  if (compressed.byteLength > input.maxBytes) {
    throw new CheckpointTooLargeError(
      `Compressed checkpoint patch is ${compressed.byteLength} bytes, above the ${input.maxBytes}-byte limit.`,
    );
  }

  const patchSha256 = sha256CheckpointPatch(patch);
  const kind = parseCheckpointKind(input.kind);
  const patchFormat = parsePatchFormat(input.patchFormat ?? CHECKPOINT_PATCH_FORMAT);
  const patchCompression = parsePatchCompression(
    input.patchCompression ?? CHECKPOINT_PATCH_COMPRESSION,
  );
  const completedPhase = input.completedPhase ?? null;
  const resumePhase = safeResumePhase(kind, completedPhase, input.resumePhase);
  assertCheckpointKindFields(kind, completedPhase, input.agentTurn ?? null);
  if (input.resumePhase !== undefined && input.resumePhase !== resumePhase) {
    throw new CheckpointCorruptError(
      `Checkpoint resume phase ${input.resumePhase} does not match ${resumePhase}.`,
    );
  }

  if (executor === db) {
    return db.transaction((tx) =>
      insertCheckpoint(
        {
          ...input,
          kind,
          state,
          patch,
          compressed,
          patchSha256,
          patchByteSize,
          patchFormat,
          patchCompression,
          completedPhase,
          resumePhase,
        },
        tx,
      ),
    );
  }

  return insertCheckpoint(
    {
      ...input,
      kind,
      state,
      patch,
      compressed,
      patchSha256,
      patchByteSize,
      patchFormat,
      patchCompression,
      completedPhase,
      resumePhase,
    },
    executor,
  );
}

interface PreparedCheckpoint extends Omit<RecordCheckpointInput, "state" | "patch"> {
  kind: CheckpointKind;
  state: CheckpointStateV1;
  patch: Buffer;
  compressed: Buffer;
  patchSha256: string;
  patchByteSize: number;
  patchFormat: CheckpointPatchFormat;
  patchCompression: CheckpointPatchCompression;
  completedPhase: JobStatus | null;
  resumePhase: JobStatus;
}

async function insertCheckpoint(
  input: PreparedCheckpoint,
  executor: Executor,
): Promise<JobCheckpoint> {
  const [owned] = await executor
    .select({
      leaseOwner: jobs.leaseOwner,
      leaseExpiresAt: jobs.leaseExpiresAt,
      now: sql`now()`.mapWith(jobs.createdAt),
    })
    .from(jobs)
    .where(eq(jobs.id, input.jobId))
    .limit(1)
    .for("update");

  if (
    owned?.leaseOwner !== input.leaseOwner ||
    owned?.leaseExpiresAt === null ||
    owned?.leaseExpiresAt === undefined ||
    owned.leaseExpiresAt <= owned.now
  ) {
    throw new LeaseLostError(`Job ${input.jobId} is no longer leased by ${input.leaseOwner}.`);
  }

  const [latest] = await executor
    .select({ sequence: jobCheckpoints.sequence })
    .from(jobCheckpoints)
    .where(eq(jobCheckpoints.jobId, input.jobId))
    .orderBy(desc(jobCheckpoints.sequence))
    .limit(1);

  const sequence = (latest?.sequence ?? 0) + 1;
  const [row] = await executor
    .insert(jobCheckpoints)
    .values({
      jobId: input.jobId,
      sequence,
      attemptCount: input.attemptCount,
      kind: input.kind,
      completedPhase: input.completedPhase,
      resumePhase: input.resumePhase,
      agentTurn: input.agentTurn ?? null,
      baseCommitSha: input.baseCommitSha,
      sandboxId: input.sandboxId,
      envFingerprint: input.envFingerprint,
      stateJson: input.state,
      patchFormat: input.patchFormat,
      patchCompression: input.patchCompression,
      patchSha256: input.patchSha256,
      patchByteSize: input.patchByteSize,
      patchCompressedBytes: input.compressed.byteLength,
      patchPayload: input.compressed,
    })
    .returning();

  if (!row) throw new Error("Insert into job_checkpoints returned no row.");

  const checkpoint = toRestorableCheckpoint(row, { maxBytes: input.maxBytes });
  await appendEvent(
    {
      jobId: input.jobId,
      type: "checkpoint.created",
      message: `Checkpoint ${sequence} (${input.kind}) created.`,
      data: {
        checkpointId: checkpoint.id,
        checkpointSequence: checkpoint.sequence,
        checkpointKind: checkpoint.kind,
        ...(checkpoint.completedPhase ? { completedPhase: checkpoint.completedPhase } : {}),
        resumePhase: checkpoint.resumePhase,
        attempt: checkpoint.attemptCount,
        ...(checkpoint.agentTurn === null ? {} : { turn: checkpoint.agentTurn }),
        sandboxId: checkpoint.sandboxId,
        patchFormat: checkpoint.patchFormat,
        patchCompression: checkpoint.patchCompression,
        patchSha256: checkpoint.patchSha256,
        patchByteSize: checkpoint.patchByteSize,
        patchCompressedBytes: checkpoint.patchCompressedBytes,
        ...(input.patchStats ?? {}),
      },
      leaseOwner: input.leaseOwner,
    },
    executor,
  );

  return checkpoint;
}

/** Reads one checkpoint by id, scoped to its job. */
export async function getCheckpoint(
  jobId: string,
  checkpointId: number,
  optionsOrExecutor: CheckpointReadOptions | Executor = db,
  maybeExecutor: Executor = db,
): Promise<JobCheckpoint | null> {
  if (!Number.isSafeInteger(checkpointId) || checkpointId < 1) return null;

  const { options, executor } = splitReadArguments(optionsOrExecutor, maybeExecutor);
  const [row] = await executor
    .select()
    .from(jobCheckpoints)
    .where(and(eq(jobCheckpoints.jobId, jobId), eq(jobCheckpoints.id, checkpointId)))
    .limit(1);

  return row ? toRestorableCheckpoint(row, options) : null;
}

/** Reads the newest checkpoint for one job, without skipping a corrupt row. */
export async function getLatestCheckpoint(
  jobId: string,
  optionsOrExecutor: CheckpointReadOptions | Executor = db,
  maybeExecutor: Executor = db,
): Promise<JobCheckpoint | null> {
  const { options, executor } = splitReadArguments(optionsOrExecutor, maybeExecutor);
  const [row] = await executor
    .select()
    .from(jobCheckpoints)
    .where(eq(jobCheckpoints.jobId, jobId))
    .orderBy(desc(jobCheckpoints.sequence))
    .limit(1);

  return row ? toRestorableCheckpoint(row, options) : null;
}

function splitReadArguments(
  optionsOrExecutor: CheckpointReadOptions | Executor,
  maybeExecutor: Executor,
): { options: CheckpointReadOptions; executor: Executor } {
  if (optionsOrExecutor === db) return { options: {}, executor: db };
  if (isReadOptions(optionsOrExecutor)) {
    return { options: optionsOrExecutor, executor: maybeExecutor };
  }
  return { options: {}, executor: optionsOrExecutor };
}

function isReadOptions(value: CheckpointReadOptions | Executor): value is CheckpointReadOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    ("maxBytes" in value || Object.keys(value).length === 0)
  );
}

function validateRecordInput(input: RecordCheckpointInput): void {
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0) {
    throw new CheckpointCorruptError(`Invalid checkpoint attempt count: ${input.attemptCount}.`);
  }
  assertByteLimit(input.maxBytes);
  if (!nonEmptyStringOrNull(input.baseCommitSha)) {
    throw new CheckpointCorruptError("A checkpoint requires a non-empty base commit SHA.");
  }
  if (!nonEmptyStringOrNull(input.sandboxId)) {
    throw new CheckpointCorruptError("A checkpoint requires a non-empty sandbox id.");
  }
  if (!isJsonObject(input.envFingerprint)) {
    throw new CheckpointCorruptError("A checkpoint environment fingerprint must be an object.");
  }
  if (!(input.patch instanceof Uint8Array)) {
    throw new CheckpointCorruptError("A checkpoint patch must be a Uint8Array.");
  }
  if (input.patchStats !== undefined) validatePatchStats(input.patchStats);
  if (input.agentTurn !== undefined && input.agentTurn !== null) {
    if (!Number.isSafeInteger(input.agentTurn) || input.agentTurn < 0) {
      throw new CheckpointCorruptError(`Invalid checkpoint agent turn: ${input.agentTurn}.`);
    }
  }
}

function assertCheckpointKindFields(
  kind: CheckpointKind,
  completedPhase: JobStatus | null,
  agentTurn: number | null,
): void {
  if (kind === "agent_turn" && agentTurn === null) {
    throw new CheckpointCorruptError("An agent-turn checkpoint must record its cumulative turn.");
  }
  if (kind === "agent_turn" && completedPhase !== null) {
    throw new CheckpointCorruptError("An agent-turn checkpoint cannot complete a phase.");
  }
}

function parseCheckpointKind(value: string): CheckpointKind {
  const parsed = checkpointKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new CheckpointCorruptError(`Unsupported checkpoint kind ${value}.`);
  }
  return parsed.data;
}

function parsePatchFormat(value: string): CheckpointPatchFormat {
  const parsed = checkpointPatchFormatSchema.safeParse(value);
  if (!parsed.success) {
    throw new CheckpointCorruptError(`Unsupported checkpoint patch format ${value}.`);
  }
  return parsed.data;
}

function parsePatchCompression(value: string): CheckpointPatchCompression {
  const parsed = checkpointPatchCompressionSchema.safeParse(value);
  if (!parsed.success) {
    throw new CheckpointCorruptError(`Unsupported checkpoint compression ${value}.`);
  }
  return parsed.data;
}

function parseStatus(value: string, field: string): JobStatus {
  const parsed = jobStatusSchema.safeParse(value);
  if (!parsed.success) throw new CheckpointCorruptError(`Invalid ${field}: ${value}.`);
  return parsed.data;
}

function parseNullableStatus(value: string | null, field: string): JobStatus | null {
  return value === null ? null : parseStatus(value, field);
}

function safeResumePhase(
  kind: CheckpointKind,
  completedPhase: JobStatus | null,
  requestedResumePhase?: JobStatus,
): JobStatus {
  try {
    return resumePhaseForCheckpoint(kind, completedPhase, requestedResumePhase);
  } catch (error) {
    throw new CheckpointCorruptError(
      `Invalid ${kind} checkpoint phase mapping: ${describeError(error)}.`,
      { cause: error },
    );
  }
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new CheckpointCorruptError("Checkpoint patch payload is not binary data.");
}

function parseJsonObject(value: unknown, field: string): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success)
    throw new CheckpointCorruptError(`Invalid ${field}: ${parsed.error.message}.`);
  return parsed.data;
}

function readVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as { version?: unknown }).version;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CheckpointCorruptError(`Invalid ${field}.`);
  }
  return value;
}

function nonEmptyStringOrNull(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CheckpointCorruptError(`Invalid checkpoint ${field}: ${String(value)}.`);
  }
  return value as number;
}

function safeNonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CheckpointCorruptError(`Invalid checkpoint ${field}: ${String(value)}.`);
  }
  return value as number;
}

function validatePatchStats(value: CheckpointPatchStats): void {
  for (const [name, count] of Object.entries(value)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new CheckpointCorruptError(`Invalid checkpoint patch stat ${name}: ${String(count)}.`);
    }
  }
  if (
    !Object.prototype.hasOwnProperty.call(value, "filesChanged") ||
    !Object.prototype.hasOwnProperty.call(value, "insertions") ||
    !Object.prototype.hasOwnProperty.call(value, "deletions")
  ) {
    throw new CheckpointCorruptError("Checkpoint patch stats must include all three totals.");
  }
}

function assertByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CheckpointCorruptError(`Invalid checkpoint byte limit: ${String(value)}.`);
  }
}

function isOutputLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
