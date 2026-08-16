/* eslint-disable no-console -- a child process reports through its own stdio */
import { readFileSync } from "node:fs";

import { approvingReview, FakeCodingAgent } from "@rivet/agent";
import type { Publish } from "@rivet/core";
import { BullJobQueue, createJobRunQueue } from "@rivet/queue";

import { resolveIntegrationEnv } from "./env";
import {
  type CaptureVariant,
  publicationClient,
  publicationGitHub,
  publicationPipeline,
  publicationSandbox,
} from "./publication-fixture";
import { successfulSession } from "./review-fixture";
import { startTestWorker, TEST_CONFIG } from "./support";

/**
 * A worker that dies inside `finalizing`, in a process of its own.
 *
 * Acceptance runs C and D are about the two windows publication cannot make
 * atomic: between the branch name becoming durable and the push, and between
 * the push and the receipt that records it. Neither can be reached from inside
 * the test process - a thrown error is a graceful failure and `process.exit()`
 * still unwinds - so the kill is a real `SIGKILL` delivered from inside the
 * wrapped host publication, which is the only place that knows the push has
 * just landed on the remote.
 *
 *   tsx publication-crash-worker.ts <queue> <worker id> <fixture json> <mode>
 */

const [queueName, workerId, fixturePath, mode] = process.argv.slice(2);
if (
  !queueName ||
  !workerId ||
  !fixturePath ||
  (mode !== "kill-after-push" && mode !== "kill-before-push")
) {
  console.error(
    "usage: publication-crash-worker.ts <queue> <worker id> <fixture json> " +
      "kill-after-push|kill-before-push",
  );
  process.exit(2);
}

interface CrashFixture {
  variant: CaptureVariant;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as CrashFixture;

resolveIntegrationEnv();

const queue = new BullJobQueue(createJobRunQueue(queueName, {}));
const client = publicationClient();
const github = publicationGitHub(client);
const phases = publicationPipeline({
  sandbox: publicationSandbox(fixture.variant),
  coding: new FakeCodingAgent({
    script: [successfulSession("implementation")],
    reviewerScript: { review: approvingReview() },
  }),
  github: { ...github, publish: crashingPublish(github.publish) },
});

const worker = startTestWorker({ queue, workerId, withSweeper: true, phases });

await queue.scheduleSweeps(TEST_CONFIG.sweepIntervalMs);
console.log(`publication-crash-worker ${workerId} ready on ${queueName} (${mode})`);

worker.worker.on("error", (error) => {
  console.error(`publication-crash-worker ${workerId}: ${error.message}`);
});

/**
 * The real host publication, wrapped in the moment the test needs.
 *
 * `kill-before-push` dies after `branch.created` and its lease-fenced column
 * write, with nothing on the remote. `kill-after-push` dies once the branch is
 * genuinely on the remote and before `external_effect.recorded` can commit,
 * which is the state the receipt protocol exists to reconcile.
 */
function crashingPublish(inner: Publish): Publish {
  return async (input) => {
    if (mode === "kill-before-push") process.kill(process.pid, "SIGKILL");

    const result = await inner(input);
    process.kill(process.pid, "SIGKILL");
    // Unreachable: SIGKILL cannot be handled, so this line exists only to keep
    // the signature honest.
    return result;
  };
}
