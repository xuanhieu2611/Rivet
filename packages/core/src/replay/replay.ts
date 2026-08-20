import {
  EXTERNAL_EFFECT_KINDS,
  EXTERNAL_EFFECT_PROVIDERS,
  isTerminal,
  type CreateJob,
  type ExternalEffectKind,
  type ExternalEffectProvider,
  type JobDetail,
  type JobEventData,
} from "@rivet/contracts";
import { db, type Database, type Job, jobs } from "@rivet/database";
import { eq } from "drizzle-orm";

import { recordArtifact } from "../artifacts/artifact-store";
import { appendEvent } from "../events/event-service";
import { recordExternalEffectWithResult } from "../github/effect-store";
import { recordAgentUsage } from "../jobs/agent-usage";
import { claimJob, heartbeat } from "../jobs/claims";
import { createJob, toJobDetail, type CreateJobInput } from "../jobs/job-service";
import { recordProvisioning, type ProvisioningPatch } from "../jobs/provisioning";
import { recordPublication, type PublicationPatch } from "../jobs/publication";
import { recordReview } from "../jobs/review";
import { transitionJob, TransitionConflictError } from "../jobs/transitions";
import { recordCommand } from "../sandbox/command-log";
import type { Redactor } from "../telemetry/redaction";
import {
  isJobStatus,
  isStatusTransition,
  pacedDelayMs,
  type LoadedReplayFixture,
  type ReplayArtifact,
  type ReplayCommand,
  type ReplayCreatedInput,
  type ReplayEvent,
  type ReplayJobFacts,
} from "./fixture";

/**
 * Replays a captured job through the production writers.
 *
 * `createJob()`, `claimJob()`, `transitionJob()`, `appendEvent()`,
 * `recordArtifact()`, `recordCommand()`, and the status-free job writers are
 * the only things that touch Postgres. A fixture loader that inserted rows
 * directly would break the single-writer invariants in the one place the
 * breakage is invisible: a demo.
 */

export interface ReplayFixtureOptions {
  leaseOwner: string;
  /** How long the synthetic claim is good for without a heartbeat. */
  leaseSeconds: number;
  /**
   * Same meaning as `RIVET_PIPELINE_SPEED`: 1 plays at recorded time, 0 is
   * instant, 0.3 fits a three-minute run into about a minute.
   */
  speed: number;
  /** Cap passed to `recordArtifact`. Already-captured content is not re-clipped. */
  artifactMaxBytes: number;
  database?: Database;
  redactor?: Redactor;
  /** How often to renew the lease during paced playback. */
  heartbeatIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReplayFixtureResult {
  job: JobDetail;
}

/** Synthetic lease owner for a named fixture, so a live worker is easy to spot. */
export function replayLeaseOwner(name: string): string {
  return `rivet-replay:${name}`;
}

/**
 * Remaps serial ids in event payloads onto the rows this replay just wrote.
 *
 * Artifact and command ids are globally monotonic, so the captured numbers
 * cannot be reused. Events that still point at the original ids would render
 * a timeline whose fetches 404.
 */
export function remapEventData(
  data: JobEventData | null,
  artifacts: ReadonlyMap<number, number>,
  commands: ReadonlyMap<number, number>,
): JobEventData | undefined {
  if (data === null) return undefined;
  let next: JobEventData = { ...data };
  next = remapId(next, "artifactId", artifacts, "artifact");
  next = remapId(next, "bodyArtifactId", artifacts, "artifact");
  next = remapId(next, "commandId", commands, "command");
  return next;
}

/**
 * Creates a real job and walks the recorded stream through the real writers.
 *
 * Does not enqueue. A running worker can still race the `queued` row between
 * `createJob()` and `claimJob()`; a failed claim says so rather than inserting
 * a second history.
 */
export async function replayFixture(
  fixture: LoadedReplayFixture,
  options: ReplayFixtureOptions,
): Promise<ReplayFixtureResult> {
  const database = options.database ?? db;
  const sleep = options.sleep ?? defaultSleep;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor((options.leaseSeconds * 1_000) / 3));
  const artifactsById = indexById(fixture.artifacts);
  const commandsById = indexById(fixture.commands);
  const artifactIds = new Map<number, number>();
  const commandIds = new Map<number, number>();

  const created = await createJob(toCreateJobInput(fixture.created), database);
  let leaseHeld = false;
  let previousOffsetMs = 0;

  const renew = async (): Promise<void> => {
    if (!leaseHeld) return;
    const result = await heartbeat(created.id, options.leaseOwner, options.leaseSeconds, database);
    if (result === null) {
      throw leaseLost(created.id, options.leaseOwner);
    }
  };

  try {
    for (const event of fixture.events) {
      const delay = pacedDelayMs(previousOffsetMs, event.offsetMs, options.speed);
      previousOffsetMs = event.offsetMs;
      await waitWithHeartbeat(delay, heartbeatIntervalMs, sleep, renew);

      if (event.type === "job.created") continue;

      if (event.type === "job.claimed") {
        await claimCapturedJob(created.id, options, database);
        leaseHeld = true;
        continue;
      }

      if (event.type === "artifact.recorded") {
        await replayArtifact(
          created.id,
          event,
          artifactsById,
          artifactIds,
          commandIds,
          options,
          database,
          leaseHeld,
        );
        continue;
      }

      if (event.type === "command.completed") {
        await replayCommand(
          created.id,
          event,
          commandsById,
          artifactIds,
          commandIds,
          options,
          database,
          leaseHeld,
        );
        continue;
      }

      if (event.type === "external_effect.recorded") {
        await replayExternalEffect(
          created.id,
          event,
          artifactIds,
          commandIds,
          options,
          database,
          leaseHeld,
        );
        continue;
      }

      if (isStatusTransition(event)) {
        leaseHeld = await replayTransition(
          created.id,
          event,
          fixture.facts,
          artifactIds,
          commandIds,
          options,
          database,
          leaseHeld,
        );
        continue;
      }

      await appendCaptured(
        created.id,
        event,
        artifactIds,
        commandIds,
        options,
        database,
        leaseHeld,
      );
    }
  } catch (error) {
    if (error instanceof TransitionConflictError) {
      throw new Error(
        `${error.message} Stop the worker if it is running; a live claim raced this replay.`,
        { cause: error },
      );
    }
    throw error;
  }

  const job = await readJob(created.id, database);
  return { job };
}

async function claimCapturedJob(
  jobId: string,
  options: ReplayFixtureOptions,
  database: Database,
): Promise<void> {
  const generation = await readDispatchGeneration(jobId, database);
  const claimed = await claimJob(
    jobId,
    options.leaseOwner,
    options.leaseSeconds,
    generation,
    database,
  );
  if (!claimed) {
    throw new Error(
      `Could not claim job ${jobId} for replay. Stop the worker (it may have raced the queued row) and retry.`,
    );
  }
}

async function replayTransition(
  jobId: string,
  event: ReplayEvent,
  facts: ReplayJobFacts,
  artifacts: Map<number, number>,
  commands: Map<number, number>,
  options: ReplayFixtureOptions,
  database: Database,
  leaseHeld: boolean,
): Promise<boolean> {
  const from = event.data?.from;
  const to = event.data?.to;
  if (!isJobStatus(from) || !isJobStatus(to)) {
    throw new Error(`Status-changing event ${event.type} is missing from/to.`);
  }

  if (leaseHeld && isTerminal(to)) {
    await persistDetailFacts(jobId, options.leaseOwner, facts, database);
  }

  const extra = extraTransitionData(event.data, artifacts, commands);
  const terminal = isTerminal(to);
  const reclaim = to === "queued";

  await transitionJob(
    {
      jobId,
      from,
      to,
      type: event.type,
      message: event.message,
      ...(extra === undefined ? {} : { data: extra }),
      ...(leaseHeld ? { leaseOwner: options.leaseOwner } : {}),
      ...(options.redactor ? { redactor: options.redactor } : {}),
      ...(terminal || reclaim
        ? {
            patch: (current: Job, now: Date) =>
              terminal
                ? {
                    completedAt: now,
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    ...(facts.failureReason === null ? {} : { failureReason: facts.failureReason }),
                    ...(facts.failureCategory === null
                      ? {}
                      : { failureCategory: facts.failureCategory }),
                  }
                : {
                    // Same write as the sweeper: clear the lease and advance
                    // the generation so the next `claimJob` can succeed.
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    dispatchGeneration: current.dispatchGeneration + 1,
                  },
          }
        : {}),
    },
    database,
  );

  return !terminal && !reclaim;
}

async function replayArtifact(
  jobId: string,
  event: ReplayEvent,
  artifactsById: ReadonlyMap<number, ReplayArtifact>,
  artifactIds: Map<number, number>,
  commandIds: Map<number, number>,
  options: ReplayFixtureOptions,
  database: Database,
  leaseHeld: boolean,
): Promise<void> {
  const originalId = event.data?.artifactId;
  if (typeof originalId !== "number") {
    throw new Error("artifact.recorded is missing artifactId.");
  }
  const captured = artifactsById.get(originalId);
  if (!captured) {
    throw new Error(`Fixture is missing artifacts/${String(originalId)}.json.`);
  }

  const maxBytes = Math.max(
    options.artifactMaxBytes,
    Buffer.byteLength(captured.content, "utf8"),
    1,
  );
  await database.transaction(async (tx) => {
    const recorded = await recordArtifact(
      {
        jobId,
        type: captured.type,
        phase: captured.phase,
        content: captured.content,
        maxBytes,
        ...(captured.metadata === null ? {} : { metadata: captured.metadata }),
        ...(leaseHeld ? { leaseOwner: options.leaseOwner } : {}),
        ...(options.redactor ? { redactor: options.redactor } : {}),
      },
      tx,
    );
    artifactIds.set(originalId, recorded.id);
    await appendEvent(appendInput(jobId, event, artifactIds, commandIds, options, leaseHeld), tx);
  });
}

async function replayCommand(
  jobId: string,
  event: ReplayEvent,
  commandsById: ReadonlyMap<number, ReplayCommand>,
  artifactIds: Map<number, number>,
  commandIds: Map<number, number>,
  options: ReplayFixtureOptions,
  database: Database,
  leaseHeld: boolean,
): Promise<void> {
  const originalId = event.data?.commandId;
  if (typeof originalId !== "number") {
    throw new Error("command.completed is missing commandId.");
  }
  const captured = commandsById.get(originalId);
  if (!captured) {
    throw new Error(`Fixture is missing commands/${String(originalId)}.json.`);
  }

  await database.transaction(async (tx) => {
    const recorded = await recordCommand(
      {
        jobId,
        phase: captured.phase,
        result: {
          argv: captured.argv,
          cwd: captured.cwd,
          exitCode: captured.exitCode,
          stdout: captured.stdout,
          stderr: captured.stderr,
          truncated: captured.truncated,
          timedOut: captured.timedOut,
          oomKilled: captured.oomKilled,
          durationMs: captured.durationMs,
        },
        ...(leaseHeld ? { leaseOwner: options.leaseOwner } : {}),
        ...(options.redactor ? { redactor: options.redactor } : {}),
      },
      tx,
    );
    commandIds.set(originalId, recorded.id);
    await appendEvent(appendInput(jobId, event, artifactIds, commandIds, options, leaseHeld), tx);
  });
}

async function replayExternalEffect(
  jobId: string,
  event: ReplayEvent,
  artifactIds: Map<number, number>,
  commandIds: Map<number, number>,
  options: ReplayFixtureOptions,
  database: Database,
  leaseHeld: boolean,
): Promise<void> {
  const kind = asExternalEffectKind(event.data?.kind);
  const externalId = requiredString(event.data?.externalId, "external_effect.recorded.externalId");
  const externalUrl = requiredString(
    event.data?.externalUrl,
    "external_effect.recorded.externalUrl",
  );

  await database.transaction(async (tx) => {
    await recordExternalEffectWithResult(
      {
        jobId,
        kind,
        externalId,
        externalUrl,
        ...optionalProvider(event.data?.provider),
        ...(leaseHeld ? { leaseOwner: options.leaseOwner } : {}),
      },
      tx,
    );
    await appendEvent(appendInput(jobId, event, artifactIds, commandIds, options, leaseHeld), tx);
  });
}

async function appendCaptured(
  jobId: string,
  event: ReplayEvent,
  artifactIds: Map<number, number>,
  commandIds: Map<number, number>,
  options: ReplayFixtureOptions,
  database: Database,
  leaseHeld: boolean,
): Promise<void> {
  await appendEvent(
    appendInput(jobId, event, artifactIds, commandIds, options, leaseHeld),
    database,
  );
}

function appendInput(
  jobId: string,
  event: ReplayEvent,
  artifactIds: ReadonlyMap<number, number>,
  commandIds: ReadonlyMap<number, number>,
  options: ReplayFixtureOptions,
  leaseHeld: boolean,
): Parameters<typeof appendEvent>[0] {
  const data = remapEventData(event.data, artifactIds, commandIds);
  return {
    jobId,
    type: event.type,
    message: event.message,
    ...(data === undefined ? {} : { data }),
    ...(leaseHeld ? { leaseOwner: options.leaseOwner } : {}),
    ...(options.redactor ? { redactor: options.redactor } : {}),
  };
}

async function persistDetailFacts(
  jobId: string,
  leaseOwner: string,
  facts: ReplayJobFacts,
  database: Database,
): Promise<void> {
  const provisioning: ProvisioningPatch = {
    ...(facts.baseCommitSha === null ? {} : { baseCommitSha: facts.baseCommitSha }),
    ...(facts.envFingerprint === null ? {} : { envFingerprint: facts.envFingerprint }),
  };
  if (Object.keys(provisioning).length > 0) {
    const held = await recordProvisioning(jobId, leaseOwner, provisioning, database);
    if (!held) throw leaseLost(jobId, leaseOwner);
  }

  const publication: PublicationPatch = {
    ...(facts.finalBranch === null ? {} : { finalBranch: facts.finalBranch }),
    ...(facts.pullRequestNumber === null ? {} : { pullRequestNumber: facts.pullRequestNumber }),
    ...(facts.pullRequestUrl === null ? {} : { pullRequestUrl: facts.pullRequestUrl }),
  };
  if (Object.keys(publication).length > 0) {
    const held = await recordPublication(jobId, leaseOwner, publication, database);
    if (!held) throw leaseLost(jobId, leaseOwner);
  }

  if (facts.reviewDecision !== null) {
    const held = await recordReview(
      jobId,
      leaseOwner,
      {
        reviewDecision: facts.reviewDecision,
        reviewLoops: facts.reviewLoops,
        ...(facts.reviewBlockingCount === null
          ? {}
          : { reviewBlockingCount: facts.reviewBlockingCount }),
      },
      database,
    );
    if (!held) throw leaseLost(jobId, leaseOwner);
  }

  const held = await recordAgentUsage(
    jobId,
    leaseOwner,
    {
      totalInputTokens: facts.totalInputTokens,
      totalOutputTokens: facts.totalOutputTokens,
      totalCostUsd: facts.totalCostUsd,
      totalTurns: facts.totalTurns,
      totalModelCalls: facts.totalModelCalls,
      totalToolCalls: facts.totalToolCalls,
    },
    database,
  );
  if (!held) throw leaseLost(jobId, leaseOwner);
}

function extraTransitionData(
  data: JobEventData | null,
  artifacts: ReadonlyMap<number, number>,
  commands: ReadonlyMap<number, number>,
): JobEventData | undefined {
  const remapped = remapEventData(data, artifacts, commands);
  if (remapped === undefined) return undefined;
  const { from: _from, to: _to, ...rest } = remapped;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

function toCreateJobInput(created: ReplayCreatedInput): CreateJobInput {
  const input: CreateJob = {
    title: created.title,
    description: created.description,
    repoUrl: created.repoUrl,
    baseBranch: created.baseBranch,
    reviewMode: created.reviewMode,
    maxReviewLoops: created.maxReviewLoops,
    maxDurationSeconds: created.maxDurationSeconds,
    maxCostUsd: created.maxCostUsd,
    maxModelCalls: created.maxModelCalls,
    maxToolCalls: created.maxToolCalls,
    ...(created.githubInstallationId === undefined
      ? {}
      : { githubInstallationId: created.githubInstallationId }),
    ...(created.repoOwner === undefined ? {} : { repoOwner: created.repoOwner }),
    ...(created.repoName === undefined ? {} : { repoName: created.repoName }),
    ...(created.issueNumber === undefined ? {} : { issueNumber: created.issueNumber }),
    ...(created.issueUrl === undefined ? {} : { issueUrl: created.issueUrl }),
  };
  return input;
}

function remapId(
  data: JobEventData,
  key: "artifactId" | "bodyArtifactId" | "commandId",
  map: ReadonlyMap<number, number>,
  kind: string,
): JobEventData {
  const original = data[key];
  if (typeof original !== "number") return data;
  const mapped = map.get(original);
  if (mapped === undefined) {
    throw new Error(
      `Replay fixture referenced ${kind} ${String(original)}, which was not recorded.`,
    );
  }
  return { ...data, [key]: mapped };
}

function indexById<T extends { id: number }>(items: readonly T[]): Map<number, T> {
  return new Map(items.map((item) => [item.id, item]));
}

async function readJob(jobId: string, database: Database): Promise<JobDetail> {
  const [row] = await database.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) throw new Error(`Job ${jobId} disappeared during replay.`);
  return toJobDetail(row);
}

async function readDispatchGeneration(jobId: string, database: Database): Promise<number> {
  const [row] = await database
    .select({ dispatchGeneration: jobs.dispatchGeneration })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!row) throw new Error(`Job ${jobId} disappeared during replay.`);
  return row.dispatchGeneration;
}

function asExternalEffectKind(value: unknown): ExternalEffectKind {
  if (typeof value === "string" && (EXTERNAL_EFFECT_KINDS as readonly string[]).includes(value)) {
    return value as ExternalEffectKind;
  }
  throw new Error("external_effect.recorded is missing a valid kind.");
}

function optionalProvider(
  value: unknown,
): { provider: ExternalEffectProvider } | Record<string, never> {
  if (
    typeof value === "string" &&
    (EXTERNAL_EFFECT_PROVIDERS as readonly string[]).includes(value)
  ) {
    return { provider: value as ExternalEffectProvider };
  }
  return {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${label} is required.`);
}

function leaseLost(jobId: string, leaseOwner: string): Error {
  return new Error(
    `Job ${jobId} is no longer leased by ${leaseOwner}; replay stood down. ` +
      "Stop the worker and retry.",
  );
}

async function waitWithHeartbeat(
  delayMs: number,
  heartbeatIntervalMs: number,
  sleep: (ms: number) => Promise<void>,
  renew: () => Promise<void>,
): Promise<void> {
  if (delayMs <= 0) return;
  let remaining = delayMs;
  while (remaining > 0) {
    const step = Math.min(remaining, heartbeatIntervalMs);
    await sleep(step);
    remaining -= step;
    if (remaining > 0) await renew();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
