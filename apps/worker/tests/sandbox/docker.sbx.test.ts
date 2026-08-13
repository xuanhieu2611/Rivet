import { randomUUID } from "node:crypto";

import {
  claimJob,
  createJob,
  isJobLive,
  transitionJob,
  type Sandbox,
  type SandboxSpec,
} from "@rivet/core";
import { closeDb } from "@rivet/database";
import { DockerSandboxProvider } from "@rivet/sandbox";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_IMAGE } from "../../src/config";
import { resetDatabase } from "../integration/support";

const controller = new AbortController();
const provider = new DockerSandboxProvider({
  workerId: `sandbox-suite-${process.pid}`,
  reapGraceMs: 0,
});
const owned = new Set<Sandbox>();

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    jobId: randomUUID(),
    image: process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
    workdir: process.env.SANDBOX_WORKDIR ?? "/home/node/workspace",
    memoryBytes: 256 * 1_024 * 1_024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 64,
    env: {},
    labels: {},
    ...overrides,
  };
}

async function create(overrides: Partial<SandboxSpec> = {}): Promise<Sandbox> {
  const sandbox = await provider.create(spec(overrides), controller.signal);
  owned.add(sandbox);
  return sandbox;
}

async function exec(
  sandbox: Sandbox,
  argv: string[],
  options: { timeoutMs?: number; cap?: number } = {},
) {
  return sandbox.exec({
    argv,
    cwd: "/home/node/workspace",
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: controller.signal,
    ...(options.cap === undefined ? {} : { maxOutputBytes: options.cap }),
  });
}

afterEach(async () => {
  await Promise.all([...owned].map((sandbox) => sandbox.destroy()));
  owned.clear();
});

afterAll(async () => {
  await closeDb();
});

describe("Docker sandbox adapter", () => {
  it("creates, execs with separated streams, reports non-zero, and destroys idempotently", async () => {
    const sandbox = await create();

    const streams = await exec(sandbox, [
      "node",
      "-e",
      'process.stdout.write("out"); process.stderr.write("err")',
    ]);
    expect(streams).toMatchObject({ exitCode: 0, stdout: "out", stderr: "err" });

    const nonzero = await exec(sandbox, ["node", "-e", "process.exit(23)"]);
    expect(nonzero.exitCode).toBe(23);

    await expect(sandbox.destroy()).resolves.toBeUndefined();
    await expect(sandbox.destroy()).resolves.toBeUndefined();
  });

  it("keeps output head and tail and states the exact elided byte count", async () => {
    const sandbox = await create();
    const result = await exec(
      sandbox,
      ["node", "-e", 'process.stdout.write("A".repeat(200) + "Z".repeat(200))'],
      { cap: 40 },
    );

    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain("A".repeat(20));
    expect(result.stdout).toContain("Z".repeat(20));
    expect(result.stdout).toContain("... 360 bytes elided ...");
  });

  it("kills the container when a command exceeds its timeout", async () => {
    const sandbox = await create();
    const result = await exec(sandbox, ["node", "-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 250,
    });

    expect(result).toMatchObject({ exitCode: null, timedOut: true, oomKilled: false });
  });

  it("reports a kernel memory kill as OOM rather than a generic 137", async () => {
    const sandbox = await create({ memoryBytes: 128 * 1_024 * 1_024 });
    const result = await exec(
      sandbox,
      ["node", "-e", "const chunks=[]; for (;;) chunks.push(Buffer.alloc(16 * 1024 * 1024, 1));"],
      { timeoutMs: 20_000 },
    );

    expect(result.oomKilled).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("enforces the PID ceiling against a fork bomb", async () => {
    const sandbox = await create({ pidsLimit: 32 });
    const result = await exec(sandbox, ["sh", "-c", "bomb() { bomb | bomb & }; bomb"], {
      timeoutMs: 10_000,
    });

    // dash can return either 0 or 2 after its background children exhaust the
    // cgroup. The invariant is that the kernel refuses another process.
    expect(result.stderr).toMatch(/cannot fork|resource temporarily unavailable/i);
  });

  it("runs as uid 1000 without sudo or write access to /etc", async () => {
    const sandbox = await create();

    const identity = await exec(sandbox, ["id", "-u"]);
    const sudo = await exec(sandbox, ["sudo", "-n", "true"]);
    const etc = await exec(sandbox, ["touch", "/etc/rivet-sandbox-must-not-exist"]);

    expect(identity.stdout.trim()).toBe("1000");
    expect(sudo.exitCode).not.toBe(0);
    expect(etc.exitCode).not.toBe(0);
  });

  it("reaps a terminal job's container and spares a live job's container", async () => {
    await resetDatabase();
    const terminal = await createJob({
      title: "Terminal sandbox reaper fixture",
      description: "A terminal job must lose its leaked container.",
      repoUrl: "https://github.com/rivet/example",
      baseBranch: "main",
    });
    const live = await createJob({
      title: "Live sandbox reaper fixture",
      description: "A leased job must keep its container.",
      repoUrl: "https://github.com/rivet/example",
      baseBranch: "main",
    });

    await transitionJob({
      jobId: terminal.id,
      from: "queued",
      to: "cancelled",
      message: "Terminal fixture.",
      patch: (_job, now) => ({ completedAt: now }),
    });
    await claimJob(live.id, "sandbox-reaper-test", 30);

    const terminalSandbox = await create({ jobId: terminal.id });
    const liveSandbox = await create({ jobId: live.id });
    const fixtureIds = new Set([terminal.id, live.id]);
    const removed = await provider.reap((jobId) =>
      fixtureIds.has(jobId) ? isJobLive(jobId) : Promise.resolve(true),
    );

    expect(removed).toContain(terminalSandbox.id);
    expect(removed).not.toContain(liveSandbox.id);
    expect(await isJobLive(live.id)).toBe(true);
  });
});
