import { z } from "zod";

/** Checkpoints that can be independently restored by the recovery planner. */
export const CHECKPOINT_KINDS = ["phase_boundary", "agent_turn"] as const;

export const checkpointKindSchema = z.enum(CHECKPOINT_KINDS);

export type CheckpointKind = z.infer<typeof checkpointKindSchema>;

/** The lossless Git patch representation used by Milestone 6. */
export const CHECKPOINT_PATCH_FORMATS = ["git_binary_full_index"] as const;

export const checkpointPatchFormatSchema = z.enum(CHECKPOINT_PATCH_FORMATS);

export type CheckpointPatchFormat = z.infer<typeof checkpointPatchFormatSchema>;

/** The compression applied to a checkpoint patch before it is stored. */
export const CHECKPOINT_PATCH_COMPRESSIONS = ["gzip"] as const;

export const checkpointPatchCompressionSchema = z.enum(CHECKPOINT_PATCH_COMPRESSIONS);

export type CheckpointPatchCompression = z.infer<typeof checkpointPatchCompressionSchema>;

// Short aliases keep the vocabulary convenient for callers that do not need
// to distinguish checkpoint-specific constants from the underlying format.
export const PATCH_FORMATS = CHECKPOINT_PATCH_FORMATS;
export const patchFormatSchema = checkpointPatchFormatSchema;
export const PATCH_COMPRESSIONS = CHECKPOINT_PATCH_COMPRESSIONS;
export const patchCompressionSchema = checkpointPatchCompressionSchema;
