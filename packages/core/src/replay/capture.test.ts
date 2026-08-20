import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JobEventData } from "@rivet/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { Redactor } from "../telemetry/redaction";
import { writeReplayFixture, type ReplaySource } from "./fixture";

/**
 * Acceptance run F: a sentinel secret planted in events, command transcripts
 * and artifact bodies must not appear under the capture output, while a
 * non-secret sentinel written the same way must. A redaction test without that
 * positive control passes identically against a search that has stopped
 * searching.
 */
const SECRET = "sentinel-secret-value";
const CONTROL = "public-sentinel";

const redactor: Redactor = {
  redact: (value) => value.split(SECRET).join("[REDACTED]"),
  redactDeep(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((entry) => this.redactDeep(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.redactDeep(entry)]),
      );
    }
    return value;
  },
};

function sourceWithSentinels(): ReplaySource {
  const mixed = `${CONTROL} ${SECRET}`;
  return {
    name: "redaction-probe",
    sourceJobId: "11111111-2222-3333-4444-555555555555",
    capturedAt: new Date("2026-08-19T12:00:00.000Z"),
    created: {
      title: mixed,
      description: `Task: ${mixed}`,
      repoUrl: "https://github.com/acme/widgets",
      baseBranch: "main",
      reviewMode: "independent",
      maxReviewLoops: 2,
      maxDurationSeconds: 3600,
      maxCostUsd: "5.00",
      maxModelCalls: 200,
      maxToolCalls: 500,
    },
    facts: {
      status: "completed",
      baseCommitSha: "a".repeat(40),
      envFingerprint: { note: mixed },
      finalBranch: null,
      pullRequestUrl: null,
      pullRequestNumber: null,
      failureReason: mixed,
      failureCategory: "unknown",
      reviewDecision: null,
      reviewLoops: 0,
      reviewBlockingCount: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: "0.0000",
      totalTurns: 0,
      totalModelCalls: 0,
      totalToolCalls: 0,
    },
    events: [
      {
        offsetMs: 0,
        type: "job.created",
        message: mixed,
        data: { nested: { secret: SECRET, public: CONTROL } } as unknown as JobEventData,
      },
    ],
    artifacts: [
      {
        id: 1,
        type: "diff",
        phase: "testing",
        content: `diff --git a/secret.ts b/secret.ts\n+${mixed}\n`,
        byteSize: 40,
        truncated: false,
        metadata: { note: mixed },
      },
    ],
    commands: [
      {
        id: 1,
        phase: "provisioning",
        argv: ["echo", mixed],
        cwd: "/home/node/workspace",
        exitCode: 0,
        durationMs: 1,
        stdout: mixed,
        stderr: mixed,
        truncated: false,
        timedOut: false,
        oomKilled: false,
      },
    ],
  };
}

async function readTree(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) chunks.push(await readTree(path));
    else chunks.push(await readFile(path, "utf8"));
  }
  return chunks.join("\n");
}

describe("writeReplayFixture redaction", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("strips the secret from every captured file and keeps the public control", async () => {
    const parent = await mkdtemp(join(tmpdir(), "rivet-capture-"));
    directories.push(parent);
    const directory = join(parent, "redaction-probe");

    await writeReplayFixture({
      directory,
      source: sourceWithSentinels(),
      redactor,
    });

    const tree = await readTree(directory);
    expect(tree).not.toContain(SECRET);
    expect(tree).toContain(CONTROL);
    expect(tree).toContain("[REDACTED]");
  });
});
