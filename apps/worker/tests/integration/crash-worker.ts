/* eslint-disable no-console -- a child process reports through its own stdio */
import { type Phase, recordCheckpoint, simulatedPipeline } from "@rivet/core";
import { BullJobQueue, createJobRunQueue } from "@rivet/queue";

import { resolveIntegrationEnv } from "./env";
import { startTestWorker, TEST_CONFIG } from "./support";

/**
 * A worker in a process of its own, so a test can `kill -9` it.
 *
 * Everything else in this suite runs the processor in the vitest process, which
 * is right for lease, queue and phase behaviour and useless for the one thing
 * Milestone 6 is about: a worker that stops without releasing anything, without
 * closing Redis, and without the chance to say so. That cannot be simulated
 * in-process - a thrown error is a graceful failure, and `process.exit()` still
 * unwinds - so the crash test spawns this.
 *
 * The checkpoint is written by the phase rather than captured from a workspace,
 * because this suite runs under `RIVET_SANDBOX=off` and a run with no sandbox
 * has no working tree to snapshot. What is under test here is the crash and the
 * resume that follows it; `pnpm test:sandbox` proves the bytes survive a real
 * container, and `pnpm demo:recovery` proves both at once against Docker.
 *
 *   tsx crash-worker.ts <queue name> <worker id> interrupt|finish
 */

const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PATCH = Buffer.from(
  "diff --git a/src/sum.ts b/src/sum.ts\n" +
    "--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -1 +1 @@\n-export const sum = 0;\n+export const sum = 1;\n",
);

const [queueName, workerId, mode] = process.argv.slice(2);
if (!queueName || !workerId || (mode !== "interrupt" && mode !== "finish")) {
  console.error("usage: crash-worker.ts <queue name> <worker id> interrupt|finish");
  process.exit(2);
}

resolveIntegrationEnv();

const queue = new BullJobQueue(createJobRunQueue(queueName, {}));
const worker = startTestWorker({
  queue,
  workerId,
  withSweeper: true,
  phases: mode === "interrupt" ? interruptedPipeline(workerId) : simulatedPipeline(),
});

// The recurring sweep, exactly as `index.ts` registers it. Without it the only
// reconciliation is the one at startup, which for the replacement worker runs
// before the dead worker's lease has had time to lapse - and the job would then
// wait for BullMQ's stalled-message detector, which is the delay dispatch
// generations exist to make unnecessary.
await queue.scheduleSweeps(TEST_CONFIG.sweepIntervalMs);

// The parent watches Postgres, not stdout, but a line here is what turns "the
// test timed out" into "the child never started".
console.log(`crash-worker ${workerId} ready on ${queueName} (${mode})`);

worker.worker.on("error", (error) => {
  console.error(`crash-worker ${workerId}: ${error.message}`);
});

/**
 * `implementing`, made durable and then made unresponsive.
 *
 * The checkpoint is recorded under this worker's own lease, which is what makes
 * it a real cursor rather than a row a test wrote on the outside, and then the
 * phase waits forever. It never returns, never fails and never hands the lease
 * back: the only way out of this run is the kill the parent is about to send.
 */
function interruptedPipeline(leaseOwner: string): readonly Phase[] {
  return simulatedPipeline().map((phase) =>
    phase.status === "implementing"
      ? {
          ...phase,
          run: async (ctx) => {
            await recordCheckpoint({
              jobId: ctx.job.id,
              attemptCount: ctx.job.attemptCount,
              kind: "agent_turn",
              agentTurn: 1,
              baseCommitSha: BASE_COMMIT,
              sandboxId: `sandbox-${leaseOwner}`,
              envFingerprint: { worker: leaseOwner },
              state: { version: 1 },
              patch: PATCH,
              maxBytes: TEST_CONFIG.checkpointMaxBytes,
              leaseOwner,
            });
            await new Promise<never>(() => {
              // Deliberately never settles. See the comment above.
            });
          },
        }
      : phase,
  );
}
