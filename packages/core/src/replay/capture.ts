import type { JobArtifact, JobCommand, JobEvent } from "@rivet/contracts";
import { db, type Database, jobs } from "@rivet/database";
import { eq } from "drizzle-orm";

import { getArtifact, listArtifacts } from "../artifacts/artifact-store";
import { listEvents } from "../events/event-service";
import { isJobId, toJobDetail } from "../jobs/job-service";
import { getCommand, listCommands } from "../sandbox/command-log";
import type { Redactor } from "../telemetry/redaction";
import {
  artifactsToReplayArtifacts,
  commandsToReplayCommands,
  eventsToReplayEvents,
  jobToReplayDocument,
  replayNameSchema,
  writeReplayFixture,
  type ReplayName,
  type ReplaySource,
} from "./fixture";

const PAGE = 500;

export interface CaptureJobOptions {
  /** Kebab-case fixture name. Required and never inferred from the job title. */
  name: string;
  /** Absolute path of the fixture directory to write. */
  directory: string;
  /** Applied to every byte on the way out. */
  redactor: Redactor;
  database?: Database;
  now?: () => Date;
}

/**
 * Reads a terminal job and writes a git-trackable fixture.
 *
 * The job must already be finished: capturing an in-flight run would promise a
 * replay that cannot reach a terminal status. Checkpoints are not copied.
 */
export async function captureJob(jobId: string, options: CaptureJobOptions): Promise<ReplaySource> {
  if (!isJobId(jobId)) {
    throw new Error(`Not a job id: ${jobId}`);
  }

  const name = replayNameSchema.parse(options.name);
  const database = options.database ?? db;
  const source = await loadReplaySource(jobId, name, database, options.now?.() ?? new Date());
  await writeReplayFixture({
    directory: options.directory,
    source,
    redactor: options.redactor,
  });
  return source;
}

/** Loads the capture payload without writing files, so tests can inspect it. */
export async function loadReplaySource(
  jobId: string,
  name: ReplayName,
  database: Database = db,
  capturedAt: Date = new Date(),
): Promise<ReplaySource> {
  const [row] = await database.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) {
    throw new Error(`Job ${jobId} was not found.`);
  }

  const job = toJobDetail(row);
  const document = jobToReplayDocument(job, name, capturedAt);
  const events = await listAllEvents(jobId, database);
  const artifacts = await listAllArtifacts(jobId, database);
  const commands = await listAllCommands(jobId, database);

  return {
    name,
    sourceJobId: document.sourceJobId,
    capturedAt,
    created: document.created,
    facts: document.facts,
    events: eventsToReplayEvents(events),
    artifacts: artifactsToReplayArtifacts(artifacts),
    commands: commandsToReplayCommands(commands),
  };
}

async function listAllEvents(jobId: string, database: Database): Promise<JobEvent[]> {
  const events: JobEvent[] = [];
  let after: number | undefined;
  for (;;) {
    const page = await listEvents(
      jobId,
      after === undefined ? { limit: PAGE } : { after, limit: PAGE },
      database,
    );
    events.push(...page);
    const last = page[page.length - 1];
    if (page.length < PAGE || last === undefined) break;
    after = last.id;
  }
  return events;
}

async function listAllArtifacts(jobId: string, database: Database): Promise<JobArtifact[]> {
  const summaries = [];
  let after: number | undefined;
  for (;;) {
    const page = await listArtifacts(
      jobId,
      after === undefined ? { limit: PAGE } : { after, limit: PAGE },
      database,
    );
    summaries.push(...page);
    const last = page[page.length - 1];
    if (page.length < PAGE || last === undefined) break;
    after = last.id;
  }

  const artifacts: JobArtifact[] = [];
  for (const summary of summaries) {
    const artifact = await getArtifact(jobId, summary.id, database);
    if (!artifact) {
      throw new Error(`Artifact ${summary.id} for job ${jobId} disappeared while capturing.`);
    }
    artifacts.push(artifact);
  }
  return artifacts;
}

async function listAllCommands(jobId: string, database: Database): Promise<JobCommand[]> {
  const summaries = [];
  let after: number | undefined;
  for (;;) {
    const page = await listCommands(
      jobId,
      after === undefined ? { limit: PAGE } : { after, limit: PAGE },
      database,
    );
    summaries.push(...page);
    const last = page[page.length - 1];
    if (page.length < PAGE || last === undefined) break;
    after = last.id;
  }

  const commands: JobCommand[] = [];
  for (const summary of summaries) {
    const command = await getCommand(jobId, summary.id, database);
    if (!command) {
      throw new Error(`Command ${summary.id} for job ${jobId} disappeared while capturing.`);
    }
    commands.push(command);
  }
  return commands;
}
