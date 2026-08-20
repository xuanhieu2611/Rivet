/* eslint-disable no-console -- this command is a local capture transcript */
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { captureJob, DEFAULT_REPLAY_ROOT, isJobId, replayNameSchema } from "@rivet/core";
import { closeDb } from "@rivet/database";

import { assertCaptureAllowed, findRepositoryRoot, loadRootEnv } from "./config";
import { SecretRegistry } from "./secrets";

const SECRET_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_SECRET",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "REDIS_URL",
  "RIVET_SESSION_SECRET",
] as const;

export interface CaptureArgs {
  help: boolean;
  jobId: string | null;
  name: string | null;
  out: string | null;
}

export function parseCaptureArgs(argv: readonly string[]): CaptureArgs {
  const parsed: CaptureArgs = { help: false, jobId: null, name: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--name") {
      parsed.name = requireArg(argv, ++index, argument);
    } else if (argument === "--out") {
      parsed.out = requireArg(argv, ++index, argument);
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown demo:capture argument ${argument}.`);
    } else if (parsed.jobId === null) {
      parsed.jobId = argument;
    } else {
      throw new Error(`Unexpected argument ${argument}.`);
    }
  }
  return parsed;
}

function requireArg(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} needs a value.`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: pnpm demo:capture <jobId> --name <name> [--out <directory>]

Reads a terminal job from local Postgres and writes demo/replays/<name>/.
--name is required and must be lowercase kebab-case; it is never inferred
from the job title.

The capture is a read. RIVET_REPLAY does not need to be on. NODE_ENV=production
is refused.
`);
}

function registerEnvSecrets(
  env: Record<string, string | undefined>,
  secrets: SecretRegistry,
): void {
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) continue;
    secrets.add(value);
    if (key === "GITHUB_APP_PRIVATE_KEY") {
      secrets.add(Buffer.from(value, "base64").toString("utf8"));
    }
  }
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseCaptureArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  assertCaptureAllowed(process.env);

  if (args.jobId === null) {
    throw new Error("A job id is required. Usage: pnpm demo:capture <jobId> --name <name>");
  }
  if (!isJobId(args.jobId)) {
    throw new Error(`Not a job id: ${args.jobId}`);
  }
  if (args.name === null) {
    throw new Error(
      "--name is required. Fixture names are explicit and never inferred from the job title.",
    );
  }
  const name = replayNameSchema.parse(args.name);

  const repositoryRoot = findRepositoryRoot();
  const directory =
    args.out === null
      ? join(repositoryRoot, DEFAULT_REPLAY_ROOT, name)
      : isAbsolute(args.out)
        ? args.out
        : join(repositoryRoot, args.out);

  const secrets = new SecretRegistry();
  registerEnvSecrets(process.env, secrets);

  try {
    await captureJob(args.jobId, {
      name,
      directory,
      redactor: secrets,
    });
    console.log(`Captured job ${args.jobId} as ${name}`);
    console.log(directory);
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
