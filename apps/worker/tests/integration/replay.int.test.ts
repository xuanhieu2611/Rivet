import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JobStatus } from "@rivet/contracts";
import {
  appendEvent,
  artifactDigests,
  captureJob,
  claimJob,
  commandDigests,
  createJob,
  getArtifact,
  getCommand,
  getJob,
  listArtifacts,
  listCommands,
  listEvents,
  loadReplayFixture,
  projectedEventTypes,
  recordAgentUsage,
  recordArtifact,
  recordCommand,
  recordExternalEffectWithResult,
  recordProvisioning,
  recordPublication,
  recordReview,
  replayFixture,
  replayLeaseOwner,
  transitionJob,
  type Redactor,
} from "@rivet/core";
import { db } from "@rivet/database";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeConnections, resetDatabase } from "./support";

/**
 * Acceptance run E: capture a completed job, replay it, and assert the
 * projected event types, terminal status, artifact digests and detail-page
 * facts match. Real Postgres, no Docker, no model, no worker, no Redis.
 */

const IDENTITY: Redactor = {
  redact: (value) => value,
  redactDeep: (value) => value,
};

const COMMIT = "a".repeat(40);
const DIFF = "diff --git a/src/book.ts b/src/book.ts\n+export const booked = true;\n";
const LEASE_OWNER = "rivet-test-capture";
const LEASE_SECONDS = 120;
const ENV_FINGERPRINT = { node: "24.0.0", pnpm: "10.0.0" };

const PHASES: readonly { from: JobStatus; to: JobStatus; label: string }[] = [
  { from: "provisioning", to: "analyzing", label: "Establish test baseline" },
  { from: "analyzing", to: "planning", label: "Create plan" },
  { from: "planning", to: "implementing", label: "Implement change" },
  { from: "implementing", to: "testing", label: "Validate change" },
  { from: "testing", to: "reviewing", label: "Review patch" },
  { from: "reviewing", to: "finalizing", label: "Finalize" },
];

afterEach(resetDatabase);
afterAll(closeConnections);
beforeEach(resetDatabase);

describe("capture and replay", () => {
  it("replays a captured job with matching events, artifacts and detail facts", async () => {
    const original = await seedCompletedJob();
    const parent = await mkdtemp(join(tmpdir(), "rivet-replay-e-"));
    const directory = join(parent, "acceptance-e");

    try {
      await captureJob(original.id, {
        name: "acceptance-e",
        directory,
        redactor: IDENTITY,
      });

      const fixture = await loadReplayFixture(directory);
      const replayed = await replayFixture(fixture, {
        leaseOwner: replayLeaseOwner("acceptance-e"),
        leaseSeconds: LEASE_SECONDS,
        speed: 0,
        artifactMaxBytes: 262_144,
      });

      const originalEvents = await listEvents(original.id, { limit: 200 });
      const replayedEvents = await listEvents(replayed.job.id, { limit: 200 });
      expect(projectedEventTypes(replayedEvents)).toEqual(projectedEventTypes(originalEvents));

      const originalJob = await getJob(original.id);
      expect(originalJob).not.toBeNull();
      expect(replayed.job.status).toBe("completed");
      expect(replayed.job.status).toBe(originalJob?.status);
      expect(replayed.job.baseCommitSha).toBe(COMMIT);
      expect(replayed.job.envFingerprint).toEqual(ENV_FINGERPRINT);
      expect(replayed.job.finalBranch).toBe("rivet/booking-fix");
      expect(replayed.job.pullRequestUrl).toBe("https://github.com/acme/widgets/pull/99");
      expect(replayed.job.pullRequestNumber).toBe(99);
      expect(replayed.job.reviewDecision).toBe("approve");
      expect(replayed.job.reviewLoops).toBe(0);
      expect(replayed.job.reviewBlockingCount).toBe(0);
      expect(replayed.job.totalInputTokens).toBe(120);
      expect(replayed.job.totalOutputTokens).toBe(80);
      expect(replayed.job.totalCostUsd).toBe("1.2500");
      expect(replayed.job.totalTurns).toBe(3);
      expect(replayed.job.totalModelCalls).toBe(4);
      expect(replayed.job.totalToolCalls).toBe(9);
      expect(replayed.job.githubInstallationId).toBe(4242);
      expect(replayed.job.repoOwner).toBe("acme");
      expect(replayed.job.issueNumber).toBe(7);

      expect(artifactDigests(await loadArtifactBodies(replayed.job.id))).toEqual(
        artifactDigests(await loadArtifactBodies(original.id)),
      );
      expect(commandDigests(await loadCommandBodies(replayed.job.id))).toEqual(
        commandDigests(await loadCommandBodies(original.id)),
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

async function seedCompletedJob() {
  const created = await createJob({
    title: "Fix the booking race",
    description: "Two concurrent POSTs must not double-book the slot.",
    repoUrl: "https://github.com/acme/widgets",
    baseBranch: "main",
    reviewMode: "independent",
    maxReviewLoops: 2,
    maxDurationSeconds: 3600,
    maxCostUsd: "5.00",
    maxModelCalls: 200,
    maxToolCalls: 500,
    githubInstallationId: 4242,
    repoOwner: "acme",
    repoName: "widgets",
    issueNumber: 7,
    issueUrl: "https://github.com/acme/widgets/issues/7",
  });
  const jobId = created.id;

  await appendEvent({
    jobId,
    type: "job.enqueued",
    message: "Queued for execution.",
    data: { dispatchGeneration: 0 },
  });

  const claimed = await claimJob(jobId, LEASE_OWNER, LEASE_SECONDS, 0);
  if (!claimed) throw new Error("Could not claim the seed job.");

  await appendEvent({
    jobId,
    type: "phase.started",
    message: "Provision sandbox",
    data: { phase: "Provision sandbox" },
    leaseOwner: LEASE_OWNER,
  });

  const heldProvisioning = await recordProvisioning(jobId, LEASE_OWNER, {
    baseCommitSha: COMMIT,
    envFingerprint: ENV_FINGERPRINT,
  });
  if (!heldProvisioning) throw new Error("Lost the lease while recording provisioning.");

  await appendEvent({
    jobId,
    type: "repo.cloned",
    message: `Cloned https://github.com/acme/widgets at main (${COMMIT.slice(0, 7)}).`,
    data: { commitSha: COMMIT },
    leaseOwner: LEASE_OWNER,
  });

  await recordCommandEvent(
    jobId,
    "provisioning",
    "Provision sandbox",
    ["git", "rev-parse", "HEAD"],
    `${COMMIT}\n`,
  );
  await completePhase(jobId, "Provision sandbox");

  for (const phase of PHASES) {
    await transitionJob({
      jobId,
      from: phase.from,
      to: phase.to,
      type: "phase.started",
      message: phase.label,
      data: { phase: phase.label },
      leaseOwner: LEASE_OWNER,
    });

    if (phase.to === "implementing") {
      await recordArtifactEvent(jobId, "implementing", "Implement change", DIFF);
    }

    if (phase.to === "reviewing") {
      const held = await recordReview(jobId, LEASE_OWNER, {
        reviewDecision: "approve",
        reviewLoops: 0,
        reviewBlockingCount: 0,
      });
      if (!held) throw new Error("Lost the lease while recording review.");
    }

    if (phase.to === "finalizing") {
      const published = await recordPublication(jobId, LEASE_OWNER, {
        finalBranch: "rivet/booking-fix",
        pullRequestNumber: 99,
        pullRequestUrl: "https://github.com/acme/widgets/pull/99",
      });
      if (!published) throw new Error("Lost the lease while recording publication.");

      await db.transaction(async (tx) => {
        await recordExternalEffectWithResult(
          {
            jobId,
            kind: "pull_request_opened",
            provider: "github",
            externalId: "99",
            externalUrl: "https://github.com/acme/widgets/pull/99",
            leaseOwner: LEASE_OWNER,
          },
          tx,
        );
        await appendEvent(
          {
            jobId,
            type: "external_effect.recorded",
            message: "Recorded pull_request_opened external effect.",
            data: {
              kind: "pull_request_opened",
              provider: "github",
              externalId: "99",
              externalUrl: "https://github.com/acme/widgets/pull/99",
              adopted: false,
            },
            leaseOwner: LEASE_OWNER,
          },
          tx,
        );
      });

      const usageHeld = await recordAgentUsage(jobId, LEASE_OWNER, {
        totalInputTokens: 120,
        totalOutputTokens: 80,
        totalCostUsd: "1.2500",
        totalTurns: 3,
        totalModelCalls: 4,
        totalToolCalls: 9,
      });
      if (!usageHeld) throw new Error("Lost the lease while recording usage.");
    }

    await completePhase(jobId, phase.label);
  }

  await transitionJob({
    jobId,
    from: "finalizing",
    to: "completed",
    type: "job.completed",
    message: "Job completed.",
    leaseOwner: LEASE_OWNER,
    patch: (_job, now) => ({
      completedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
    }),
  });

  const finished = await getJob(jobId);
  if (!finished) throw new Error("Seed job disappeared.");
  return finished;
}

async function completePhase(jobId: string, label: string): Promise<void> {
  await appendEvent({
    jobId,
    type: "phase.completed",
    message: `${label} finished`,
    data: { phase: label, durationMs: 1 },
    leaseOwner: LEASE_OWNER,
  });
}

async function recordCommandEvent(
  jobId: string,
  phase: JobStatus,
  phaseLabel: string,
  argv: string[],
  stdout: string,
): Promise<void> {
  const commandExecutionId = randomUUID();
  await db.transaction(async (tx) => {
    const recorded = await recordCommand(
      {
        jobId,
        phase,
        result: {
          argv,
          cwd: "/home/node/workspace",
          exitCode: 0,
          stdout,
          stderr: "",
          truncated: false,
          timedOut: false,
          oomKilled: false,
          durationMs: 12,
        },
        leaseOwner: LEASE_OWNER,
      },
      tx,
    );
    await appendEvent(
      {
        jobId,
        type: "command.completed",
        message: `${argv.join(" ")} exited 0`,
        data: {
          commandExecutionId,
          argv,
          exitCode: 0,
          durationMs: 12,
          commandId: recorded.id,
          phase: phaseLabel,
        },
        leaseOwner: LEASE_OWNER,
      },
      tx,
    );
  });
}

async function recordArtifactEvent(
  jobId: string,
  phase: JobStatus,
  phaseLabel: string,
  content: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const recorded = await recordArtifact(
      {
        jobId,
        type: "diff",
        phase,
        content,
        maxBytes: 262_144,
        leaseOwner: LEASE_OWNER,
      },
      tx,
    );
    await appendEvent(
      {
        jobId,
        type: "artifact.recorded",
        message: `Recorded ${recorded.type} artifact (${recorded.byteSize} bytes).`,
        data: {
          artifactId: recorded.id,
          artifactType: recorded.type,
          byteSize: recorded.byteSize,
          truncated: recorded.truncated,
          phase: phaseLabel,
        },
        leaseOwner: LEASE_OWNER,
      },
      tx,
    );
  });
}

async function loadArtifactBodies(jobId: string) {
  const summaries = await listArtifacts(jobId, { limit: 50 });
  const artifacts = [];
  for (const summary of summaries) {
    const artifact = await getArtifact(jobId, summary.id);
    if (!artifact) throw new Error(`Missing artifact ${String(summary.id)}.`);
    artifacts.push(artifact);
  }
  return artifacts;
}

async function loadCommandBodies(jobId: string) {
  const summaries = await listCommands(jobId, { limit: 50 });
  const commands = [];
  for (const summary of summaries) {
    const command = await getCommand(jobId, summary.id);
    if (!command) throw new Error(`Missing command ${String(summary.id)}.`);
    commands.push(command);
  }
  return commands;
}
