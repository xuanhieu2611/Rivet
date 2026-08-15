/* eslint-disable no-console -- the child reports startup and fatal exits to the parent */
import { abortableSleep, type Phase } from "@rivet/core";
import { FakeCodingAgent, approvingReview, revisingReview } from "@rivet/agent";
import { BullJobQueue, createJobRunQueue } from "@rivet/queue";

import { resolveIntegrationEnv } from "./env";
import { fixtureProvider, reviewPipeline, successfulSession } from "./review-fixture";
import { startTestWorker, TEST_CONFIG } from "./support";

/**
 * A real worker process for acceptance run F. The first child lets the real
 * review phase persist its `resumePhase: revising` boundary, then is killed as
 * soon as the revising status is entered. The replacement gets a fresh fake
 * sandbox and fake agent, so the only way it can finish is by reading the
 * durable review report and checkpoint from Postgres.
 */

const [queueName, workerId, mode] = process.argv.slice(2);
if (!queueName || !workerId || (mode !== "interrupt" && mode !== "finish")) {
  console.error("usage: review-crash-worker.ts <queue name> <worker id> interrupt|finish");
  process.exit(2);
}

resolveIntegrationEnv();

const queue = new BullJobQueue(createJobRunQueue(queueName, {}));
const coding =
  mode === "interrupt"
    ? new FakeCodingAgent({
        script: [successfulSession("implementation")],
        reviewerScript: { review: revisingReview() },
      })
    : new FakeCodingAgent({
        script: [successfulSession("revision")],
        reviewerScript: { review: approvingReview() },
      });
const phases = reviewPipeline(fixtureProvider(), coding);
const worker = startTestWorker({
  queue,
  workerId,
  withSweeper: true,
  phases,
  ...(mode === "interrupt"
    ? { faults: () => ({ sleep: abortableSleep, fault: killOnRevision }) }
    : {}),
});

await queue.scheduleSweeps(TEST_CONFIG.sweepIntervalMs);
console.log(`review-crash-worker ${workerId} ready on ${queueName} (${mode})`);

worker.worker.on("error", (error) => {
  console.error(`review-crash-worker ${workerId}: ${error.message}`);
});

function killOnRevision(phase: Phase) {
  if (phase.status === "revising") {
    // The reviewing boundary checkpoint was written before this transition, so
    // a replacement can resume at revising rather than finalizing the rejected
    // patch. SIGKILL is deliberate: graceful errors do not exercise reclaim.
    process.kill(process.pid, "SIGKILL");
  }
  return undefined;
}
