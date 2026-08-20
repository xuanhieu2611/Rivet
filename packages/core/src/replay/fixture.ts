import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  artifactTypeSchema,
  failureCategorySchema,
  isTerminal,
  JOB_STATUSES,
  jobEventTypeSchema,
  jobStatusSchema,
  reviewDecisionSchema,
  reviewModeSchema,
  type ArtifactType,
  type JobArtifact,
  type JobCommand,
  type JobDetail,
  type JobEvent,
  type JobEventData,
  type JobEventType,
  type JobStatus,
} from "@rivet/contracts";
import { z } from "zod";

import type { Redactor } from "../telemetry/redaction";

/**
 * Capture and replay fixtures.
 *
 * A replayed run is an ordinary job: created through `createJob()`, moved by
 * `transitionJob()`, its events written by `appendEvent()`. The fixture is
 * what makes that possible without a live model, and the format is the
 * contract between `pnpm demo:capture` and `pnpm demo:replay`.
 *
 * Checkpoints are deliberately absent. Replay drives the timeline and the
 * detail page, not a sandbox restore, and a compressed patch is not something
 * that belongs in a git-tracked public directory.
 */

/** Directory name under the repository root where captured runs live. */
export const DEFAULT_REPLAY_ROOT = "demo/replays";

export const REPLAY_JOB_FILE = "job.json";
export const REPLAY_EVENTS_FILE = "events.ndjson";
export const REPLAY_ARTIFACTS_DIR = "artifacts";
export const REPLAY_COMMANDS_DIR = "commands";

/**
 * Fixture names are also directory names, so they use the same kebab-case rule
 * as benchmark ids: no separators that could walk the tree, no inference from
 * a job title that might change.
 */
export const replayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Replay names must use lowercase kebab-case.");

export type ReplayName = z.infer<typeof replayNameSchema>;

const replayCreatedSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    repoUrl: z.string().min(1),
    baseBranch: z.string().min(1),
    githubInstallationId: z.number().int().positive().optional(),
    repoOwner: z.string().min(1).optional(),
    repoName: z.string().min(1).optional(),
    issueNumber: z.number().int().positive().optional(),
    issueUrl: z.string().min(1).optional(),
    reviewMode: reviewModeSchema,
    maxReviewLoops: z.number().int().min(0).max(5),
    maxDurationSeconds: z.number().int().positive(),
    maxCostUsd: z.string().min(1),
    maxModelCalls: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
  })
  .strict();

export type ReplayCreatedInput = z.infer<typeof replayCreatedSchema>;

const replayFactsSchema = z
  .object({
    status: jobStatusSchema,
    baseCommitSha: z.string().min(1).nullable(),
    envFingerprint: z.record(z.string(), z.unknown()).nullable(),
    finalBranch: z.string().min(1).nullable(),
    pullRequestUrl: z.string().min(1).nullable(),
    pullRequestNumber: z.number().int().positive().nullable(),
    failureReason: z.string().min(1).nullable(),
    failureCategory: failureCategorySchema.nullable(),
    reviewDecision: reviewDecisionSchema.nullable(),
    reviewLoops: z.number().int().nonnegative(),
    reviewBlockingCount: z.number().int().nonnegative().nullable(),
    totalInputTokens: z.number().int().nonnegative(),
    totalOutputTokens: z.number().int().nonnegative(),
    totalCostUsd: z.string().min(1),
    totalTurns: z.number().int().nonnegative(),
    totalModelCalls: z.number().int().nonnegative(),
    totalToolCalls: z.number().int().nonnegative(),
  })
  .strict();

export type ReplayJobFacts = z.infer<typeof replayFactsSchema>;

const replayJobDocumentSchema = z
  .object({
    version: z.literal(1),
    name: replayNameSchema,
    capturedAt: z.string().min(1),
    sourceJobId: z.string().min(1),
    created: replayCreatedSchema,
    facts: replayFactsSchema,
  })
  .strict();

export type ReplayJobDocument = z.infer<typeof replayJobDocumentSchema>;

const replayEventSchema = z
  .object({
    offsetMs: z.number().int().nonnegative(),
    type: jobEventTypeSchema,
    message: z.string(),
    data: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export interface ReplayEvent {
  offsetMs: number;
  type: JobEventType;
  message: string;
  data: JobEventData | null;
}

const replayArtifactSchema = z
  .object({
    id: z.number().int().positive(),
    type: artifactTypeSchema,
    phase: jobStatusSchema,
    content: z.string(),
    byteSize: z.number().int().nonnegative(),
    truncated: z.boolean(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export type ReplayArtifact = z.infer<typeof replayArtifactSchema>;

const replayCommandSchema = z
  .object({
    id: z.number().int().positive(),
    phase: jobStatusSchema,
    argv: z.array(z.string()),
    cwd: z.string(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
    oomKilled: z.boolean(),
  })
  .strict();

export type ReplayCommand = z.infer<typeof replayCommandSchema>;

/** An in-memory job ready to write as a fixture, or just written from one. */
export interface ReplaySource {
  name: ReplayName;
  sourceJobId: string;
  capturedAt: Date;
  created: ReplayCreatedInput;
  facts: ReplayJobFacts;
  events: readonly ReplayEvent[];
  artifacts: readonly ReplayArtifact[];
  commands: readonly ReplayCommand[];
}

/** A fixture loaded from disk, ready to replay. */
export interface LoadedReplayFixture extends ReplaySource {
  directory: string;
}

const JOB_STATUS_SET: ReadonlySet<string> = new Set(JOB_STATUSES);

/** True when `value` is one of the closed job statuses. */
export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && JOB_STATUS_SET.has(value);
}

/**
 * A status-changing event is one `transitionJob` wrote: it carries the concrete
 * `from` and `to` the locked row actually moved across. `phase.started` for the
 * first phase after a claim is an `appendEvent` and has no such pair.
 */
export function isStatusTransition(event: Pick<ReplayEvent, "data">): boolean {
  const from = event.data?.from;
  const to = event.data?.to;
  return isJobStatus(from) && isJobStatus(to) && from !== to;
}

/** Milliseconds to wait between two recorded offsets at a given speed. */
export function pacedDelayMs(previousOffsetMs: number, offsetMs: number, speed: number): number {
  if (!(speed > 0)) return 0;
  return Math.max(0, Math.round((offsetMs - previousOffsetMs) * speed));
}

/**
 * Builds the creation input and terminal facts a replay needs from a job row.
 *
 * Creation fields are what `createJob()` accepts. Terminal facts are what the
 * status-free writers persist so the detail page matches after a refresh.
 */
export function jobToReplayDocument(
  job: JobDetail,
  name: ReplayName,
  capturedAt: Date = new Date(),
): Pick<
  ReplayJobDocument,
  "version" | "name" | "capturedAt" | "sourceJobId" | "created" | "facts"
> {
  if (!isTerminal(job.status)) {
    throw new Error(
      `Job ${job.id} is ${job.status}; only a terminal job can be captured. ` +
        "Wait for it to finish, or pick a completed run.",
    );
  }

  return {
    version: 1,
    name,
    capturedAt: capturedAt.toISOString(),
    sourceJobId: job.id,
    created: {
      title: job.title,
      description: job.description,
      repoUrl: job.repoUrl,
      baseBranch: job.baseBranch,
      reviewMode: job.reviewMode,
      maxReviewLoops: job.maxReviewLoops,
      maxDurationSeconds: job.maxDurationSeconds,
      maxCostUsd: job.maxCostUsd,
      maxModelCalls: job.maxModelCalls,
      maxToolCalls: job.maxToolCalls,
      ...optionalNumber("githubInstallationId", job.githubInstallationId),
      ...optionalString("repoOwner", job.repoOwner),
      ...optionalString("repoName", job.repoName),
      ...optionalNumber("issueNumber", job.issueNumber),
      ...optionalString("issueUrl", job.issueUrl),
    },
    facts: {
      status: job.status,
      baseCommitSha: job.baseCommitSha,
      envFingerprint: job.envFingerprint,
      finalBranch: job.finalBranch,
      pullRequestUrl: job.pullRequestUrl,
      pullRequestNumber: job.pullRequestNumber,
      failureReason: job.failureReason,
      failureCategory: job.failureCategory,
      reviewDecision: job.reviewDecision,
      reviewLoops: job.reviewLoops,
      reviewBlockingCount: job.reviewBlockingCount,
      totalInputTokens: job.totalInputTokens,
      totalOutputTokens: job.totalOutputTokens,
      totalCostUsd: job.totalCostUsd,
      totalTurns: job.totalTurns,
      totalModelCalls: job.totalModelCalls,
      totalToolCalls: job.totalToolCalls,
    },
  };
}

/** Offsets every event from the first event's timestamp, in milliseconds. */
export function eventsToReplayEvents(events: readonly JobEvent[]): ReplayEvent[] {
  const origin = events[0]?.createdAt.getTime() ?? 0;
  return events.map((event) => ({
    offsetMs: Math.max(0, event.createdAt.getTime() - origin),
    type: event.type,
    message: event.message,
    data: event.data,
  }));
}

export function artifactsToReplayArtifacts(artifacts: readonly JobArtifact[]): ReplayArtifact[] {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    type: artifact.type,
    phase: artifact.phase,
    content: artifact.content,
    byteSize: artifact.byteSize,
    truncated: artifact.truncated,
    metadata: artifact.metadata,
  }));
}

export function commandsToReplayCommands(commands: readonly JobCommand[]): ReplayCommand[] {
  return commands.map((command) => ({
    id: command.id,
    phase: command.phase,
    argv: command.argv,
    cwd: command.cwd,
    exitCode: command.exitCode,
    durationMs: command.durationMs,
    stdout: command.stdout,
    stderr: command.stderr,
    truncated: command.truncated,
    timedOut: command.timedOut,
    oomKilled: command.oomKilled,
  }));
}

export interface WriteReplayFixtureOptions {
  /** Destination directory, e.g. `demo/replays/booking`. Replaced if it exists. */
  directory: string;
  source: ReplaySource;
  /** Applied to every string on the way out. A capture is a committed file. */
  redactor: Redactor;
}

/**
 * Writes a capture directory. Staging-then-rename so a failed write cannot
 * leave a half-fixture where `pnpm demo:replay` would read it.
 */
export async function writeReplayFixture(options: WriteReplayFixtureOptions): Promise<void> {
  const name = replayNameSchema.parse(options.source.name);
  const staging = `${options.directory}.tmp-${randomUUID()}`;
  await mkdir(join(staging, REPLAY_ARTIFACTS_DIR), { recursive: true });
  await mkdir(join(staging, REPLAY_COMMANDS_DIR), { recursive: true });

  try {
    const document = options.redactor.redactDeep({
      version: 1 as const,
      name,
      capturedAt: options.source.capturedAt.toISOString(),
      sourceJobId: options.source.sourceJobId,
      created: options.source.created,
      facts: options.source.facts,
    });
    await writeFile(
      join(staging, REPLAY_JOB_FILE),
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );

    const eventLines = options.source.events.map((event) =>
      JSON.stringify(
        options.redactor.redactDeep({
          offsetMs: event.offsetMs,
          type: event.type,
          message: event.message,
          data: event.data,
        }),
      ),
    );
    await writeFile(
      join(staging, REPLAY_EVENTS_FILE),
      `${eventLines.join("\n")}${eventLines.length > 0 ? "\n" : ""}`,
      "utf8",
    );

    for (const artifact of options.source.artifacts) {
      await writeFile(
        join(staging, REPLAY_ARTIFACTS_DIR, `${artifact.id}.json`),
        `${JSON.stringify(options.redactor.redactDeep(artifact), null, 2)}\n`,
        "utf8",
      );
    }

    for (const command of options.source.commands) {
      await writeFile(
        join(staging, REPLAY_COMMANDS_DIR, `${command.id}.json`),
        `${JSON.stringify(options.redactor.redactDeep(command), null, 2)}\n`,
        "utf8",
      );
    }

    await rm(options.directory, { recursive: true, force: true });
    await mkdir(join(options.directory, ".."), { recursive: true });
    await rename(staging, options.directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reads a capture directory back into the shape `replayFixture` walks. */
export async function loadReplayFixture(directory: string): Promise<LoadedReplayFixture> {
  const document = replayJobDocumentSchema.parse(
    JSON.parse(await readFile(join(directory, REPLAY_JOB_FILE), "utf8")) as unknown,
  );

  const eventText = await readFile(join(directory, REPLAY_EVENTS_FILE), "utf8");
  const events: ReplayEvent[] = [];
  for (const line of eventText.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parsed = replayEventSchema.parse(JSON.parse(line) as unknown);
    events.push({
      offsetMs: parsed.offsetMs,
      type: parsed.type,
      message: parsed.message,
      data: parsed.data,
    });
  }

  return {
    directory,
    name: document.name,
    sourceJobId: document.sourceJobId,
    capturedAt: new Date(document.capturedAt),
    created: document.created,
    facts: document.facts,
    events,
    artifacts: await loadJsonDir(join(directory, REPLAY_ARTIFACTS_DIR), replayArtifactSchema),
    commands: await loadJsonDir(join(directory, REPLAY_COMMANDS_DIR), replayCommandSchema),
  };
}

/** Ordered event types, which is what "projected event list" means here. */
export function projectedEventTypes(events: readonly { type: JobEventType }[]): JobEventType[] {
  return events.map((event) => event.type);
}

/** Content digests in production order, ignoring serial ids that will not match. */
export function artifactDigests(
  artifacts: readonly { type: ArtifactType; content: string }[],
): readonly { type: ArtifactType; sha256: string }[] {
  return artifacts.map((artifact) => ({
    type: artifact.type,
    sha256: sha256Utf8(artifact.content),
  }));
}

export function commandDigests(
  commands: readonly { argv: readonly string[]; stdout: string; stderr: string }[],
): readonly { argv: readonly string[]; sha256: string }[] {
  return commands.map((command) => ({
    argv: command.argv,
    sha256: sha256Utf8(`${command.stdout}\n${command.stderr}`),
  }));
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function loadJsonDir<T>(directory: string, schema: z.ZodType<T>): Promise<T[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const parsed: T[] = [];
  for (const entry of entries.sort(compareNumericNames)) {
    if (!entry.endsWith(".json")) continue;
    parsed.push(
      schema.parse(JSON.parse(await readFile(join(directory, entry), "utf8")) as unknown),
    );
  }
  return parsed;
}

function compareNumericNames(left: string, right: string): number {
  return Number.parseInt(left, 10) - Number.parseInt(right, 10);
}

function optionalString<K extends string>(
  key: K,
  value: string | null,
): Partial<Record<K, string>> {
  return value === null || value === "" ? {} : ({ [key]: value } as Partial<Record<K, string>>);
}

function optionalNumber<K extends string>(
  key: K,
  value: number | null,
): Partial<Record<K, number>> {
  return value === null ? {} : ({ [key]: value } as Partial<Record<K, number>>);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
