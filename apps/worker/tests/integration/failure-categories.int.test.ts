import type { JobEvent } from "@rivet/contracts";
import {
  buildPipeline,
  requestJobRun,
  SandboxCreateFailedError,
  type PipelineOptions,
} from "@rivet/core";
import { FakeSandboxProvider, type FakeSandboxOptions, type ScriptedCommand } from "@rivet/sandbox";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createFaultInjection, type FaultInjection } from "../../src/faults";
import {
  closeConnections,
  createTestJob,
  createTestQueue,
  readEvents,
  resetDatabase,
  startTestWorker,
  testLogger,
  waitForStatus,
  type TestQueue,
  type TestWorker,
} from "./support";

/**
 * The worker-level proof of the M2 failure taxonomy.
 *
 * This deliberately uses the scripted sandbox rather than Docker. The real
 * adapter's OOM, timeout and daemon behavior belongs to the sandbox suite in
 * Step 11; this suite proves the more important cross-package claim that each
 * named error reaches the right Postgres status and BullMQ outcome.
 */

const PIPELINE_OPTIONS: Omit<PipelineOptions, "sandbox"> = {
  image: "node@sha256:test",
  workdir: "/home/node/workspace",
  memoryBytes: 512 * 1_024 * 1_024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 128,
  commandTimeoutMs: 50,
  cloneTimeoutMs: 50,
  installTimeoutMs: 50,
  baselineTimeoutMs: 50,
  diffMaxBytes: 65_536,
};

const COMMIT = "9f2b0c1a4d5e6f708192a3b4c5d6e7f809112233";
const LISTING = ".\n..\n.git\npackage.json\npackage-lock.json\n";
const MANIFEST = JSON.stringify({ name: "fixture", scripts: { test: "node test.js" } });

let queue: TestQueue;
let worker: TestWorker | undefined;

beforeAll(() => {
  queue = createTestQueue("failure-categories", { backoff: { type: "fixed", delay: 20 } });
});

afterAll(async () => {
  await queue.destroy();
  await closeConnections();
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

interface PipelineFixture {
  provider: FakeSandboxProvider;
  phases: ReturnType<typeof buildPipeline>;
  phaseFactory: (injection: FaultInjection) => ReturnType<typeof buildPipeline>;
}

function fixtureProvider(
  extra: ScriptedCommand[] = [],
  options: Omit<FakeSandboxOptions, "script"> = {},
) {
  return new FakeSandboxProvider({
    ...options,
    script: [
      ...extra,
      { match: "ls", stdout: LISTING },
      {
        match: (argv) => argv[0] === "git" && argv[1] === "rev-parse",
        stdout: `${COMMIT}\n`,
      },
      { match: "cat", stdout: MANIFEST },
      { match: "sha256sum", stdout: "abc123  package-lock.json\n" },
      {
        match: (argv) => argv[0] === "npm" && argv[1] === "--version",
        stdout: "10.0.0\n",
      },
    ],
  });
}

function pipelineFixture(provider: FakeSandboxProvider): PipelineFixture {
  const base: PipelineOptions = { ...PIPELINE_OPTIONS, sandbox: provider };
  return {
    provider,
    phases: buildPipeline(base),
    phaseFactory: (injection) =>
      buildPipeline({ ...PIPELINE_OPTIONS, sandbox: injection.sandbox ?? provider }),
  };
}

async function runFailure(
  fixture: PipelineFixture,
  fault?: Parameters<typeof createFaultInjection>[0],
): Promise<{
  attemptCount: number;
  failureCategory: string | null;
  failureReason: string | null;
  attemptsMade: number;
  types: string[];
  events: JobEvent[];
}> {
  const job = await createTestJob();
  await requestJobRun(job.id, queue.queue);

  const faults = fault
    ? () => createFaultInjection(fault, testLogger, fixture.provider)
    : undefined;
  worker = startTestWorker({
    queue: queue.queue,
    phases: fixture.phases,
    phaseFactory: fixture.phaseFactory,
    ...(faults ? { faults } : {}),
  });

  const failed = await waitForStatus(job.id, "failed");
  const message = await queue.queue.bull.getJob(`${job.id}.0`);
  const events = await readEvents(job.id);

  return {
    attemptCount: failed.attemptCount,
    failureCategory: failed.failureCategory,
    failureReason: failed.failureReason,
    attemptsMade: message?.attemptsMade ?? 0,
    types: events.map((event) => event.type),
    events,
  };
}

describe("failure classification through the worker", () => {
  it("retries sandbox_unavailable, then persists it on the final attempt", async () => {
    const result = await runFailure(pipelineFixture(fixtureProvider()), {
      phase: "provisioning",
      mode: "no-daemon",
    });

    expect(result.failureCategory).toBe("sandbox_unavailable");
    expect(result.attemptCount).toBe(3);
    expect(result.attemptsMade).toBe(3);
    expect(result.types.filter((type) => type === "job.retry_scheduled")).toHaveLength(2);
  });

  it("retries sandbox_create_failed, then persists it on the final attempt", async () => {
    const fixture = pipelineFixture(
      fixtureProvider([], {
        createFails: new SandboxCreateFailedError("injected create failure"),
      }),
    );
    const result = await runFailure(fixture);

    expect(result.failureCategory).toBe("sandbox_create_failed");
    expect(result.attemptCount).toBe(3);
    expect(result.attemptsMade).toBe(3);
  });

  it("does not retry a repository that cannot be cloned", async () => {
    const result = await runFailure(
      pipelineFixture(
        fixtureProvider([
          {
            match: (argv) => argv[0] === "git" && argv[1] === "clone",
            exitCode: 128,
            stderr: "fatal: repository not found\n",
          },
        ]),
      ),
    );

    expect(result.failureCategory).toBe("repo_unavailable");
    expect(result.attemptCount).toBe(1);
    expect(result.attemptsMade).toBe(1);
  });

  it("records command.failed without replacing a sandbox exception", async () => {
    const cause = new Error("sandbox socket closed");
    const result = await runFailure(
      pipelineFixture(
        fixtureProvider([
          {
            match: (argv) => argv[0] === "git" && argv[1] === "clone",
            throws: cause,
          },
        ]),
      ),
    );

    const failedCommand = result.events.find((event) => event.type === "command.failed");
    expect(result.failureCategory).toBe("unknown");
    expect(result.failureReason).toContain(cause.message);
    expect(typeof failedCommand?.data?.commandExecutionId).toBe("string");
    expect(failedCommand?.data).toMatchObject({
      argv: [
        "git",
        "clone",
        "--depth",
        "1",
        "--branch",
        "main",
        "--single-branch",
        "https://github.com/rivet/example",
        "/home/node/workspace/repo",
      ],
      cwd: "/home/node/workspace",
      phase: "Provision sandbox",
      error: cause.message,
    });
  });

  it("does not retry an unsupported project", async () => {
    const result = await runFailure(
      pipelineFixture(fixtureProvider([{ match: "ls", stdout: ".\n..\nREADME.md\n" }])),
    );

    expect(result.failureCategory).toBe("unsupported_project");
    expect(result.attemptCount).toBe(1);
    expect(result.attemptsMade).toBe(1);
  });

  it("does not retry a dependency install failure", async () => {
    const result = await runFailure(
      pipelineFixture(
        fixtureProvider([
          {
            match: (argv) => argv[0] === "npm" && argv[1] === "ci",
            exitCode: 1,
            stderr: "npm ERR! invalid lockfile\n",
          },
        ]),
      ),
    );

    expect(result.failureCategory).toBe("dependency_install_failed");
    expect(result.attemptCount).toBe(1);
    expect(result.attemptsMade).toBe(1);
  });

  it("does not retry a command that outlives its own timeout", async () => {
    const result = await runFailure(
      pipelineFixture(fixtureProvider([{ match: "sleep", hang: true }])),
      { phase: "testing", mode: "slow-command" },
    );

    expect(result.failureCategory).toBe("command_timed_out");
    expect(result.attemptCount).toBe(1);
    expect(result.attemptsMade).toBe(1);
  });

  it("does not retry a sandbox OOM kill", async () => {
    const result = await runFailure(
      pipelineFixture(
        fixtureProvider([
          {
            match: (argv) => argv[0] === "node" && argv[1] === "-e",
            hang: true,
            oomKilled: true,
          },
        ]),
      ),
      { phase: "testing", mode: "oom" },
    );

    expect(result.failureCategory).toBe("oom_killed");
    expect(result.attemptCount).toBe(1);
    expect(result.attemptsMade).toBe(1);
  });
});
