/* eslint-disable no-console -- this command is a local replay transcript */
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REPLAY_ROOT,
  loadReplayFixture,
  replayFixture,
  replayLeaseOwner,
  replayNameSchema,
} from "@rivet/core";
import { closeDb } from "@rivet/database";

import { assertReplayAllowed, findRepositoryRoot, loadRootEnv } from "./config";

const DEFAULT_SPEED = 1;
const DEFAULT_LEASE_SECONDS = 3_600;
const DEFAULT_ARTIFACT_MAX_BYTES = 262_144;

export interface ReplayArgs {
  help: boolean;
  name: string | null;
  speed: number;
  dir: string | null;
}

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const parsed: ReplayArgs = { help: false, name: null, speed: DEFAULT_SPEED, dir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--speed") {
      parsed.speed = parseSpeed(requireArg(argv, ++index, argument));
    } else if (argument === "--dir") {
      parsed.dir = requireArg(argv, ++index, argument);
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown demo:replay argument ${argument}.`);
    } else if (parsed.name === null) {
      parsed.name = argument;
    } else {
      throw new Error(`Unexpected argument ${argument}.`);
    }
  }
  return parsed;
}

function parseSpeed(value: string): number {
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed < 0 || speed > 100) {
    throw new Error("--speed needs a number from 0 to 100 (1 is recorded time, 0 is instant).");
  }
  return speed;
}

function requireArg(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} needs a value.`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: pnpm demo:replay <name> [--speed N] [--dir <parent>]

Creates a real job through createJob(), claims it under a synthetic lease, and
walks the captured stream through the production writers. Does not enqueue.
Stop the worker first so it cannot race the queued row.

--speed matches RIVET_PIPELINE_SPEED: 1 plays at recorded time, 0 is instant,
0.3 fits a three-minute run into about a minute.

Requires RIVET_REPLAY=on. NODE_ENV=production is refused.
`);
}

function jobUrl(jobId: string, env: Record<string, string | undefined>): string {
  const base = (env.RIVET_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/jobs/${jobId}`;
}

function artifactMaxBytes(env: Record<string, string | undefined>): number {
  const raw = env.RIVET_ARTIFACT_MAX_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_ARTIFACT_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_ARTIFACT_MAX_BYTES;
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseReplayArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  assertReplayAllowed(process.env);

  if (args.name === null) {
    throw new Error("A fixture name is required. Usage: pnpm demo:replay <name>");
  }
  const name = replayNameSchema.parse(args.name);
  const repositoryRoot = findRepositoryRoot();
  const parent =
    args.dir === null
      ? join(repositoryRoot, DEFAULT_REPLAY_ROOT)
      : isAbsolute(args.dir)
        ? args.dir
        : join(repositoryRoot, args.dir);
  const directory = join(parent, name);
  const fixture = await loadReplayFixture(directory);

  try {
    const result = await replayFixture(fixture, {
      leaseOwner: replayLeaseOwner(name),
      leaseSeconds: DEFAULT_LEASE_SECONDS,
      speed: args.speed,
      artifactMaxBytes: artifactMaxBytes(process.env),
    });
    console.log(`Replayed ${name} as job ${result.job.id}`);
    console.log(jobUrl(result.job.id, process.env));
  } finally {
    await closeDb();
  }
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
