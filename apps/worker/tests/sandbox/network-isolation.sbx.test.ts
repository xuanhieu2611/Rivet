import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { Sandbox, SandboxSpec } from "@rivet/core";
import { closeDb } from "@rivet/database";
import { DockerSandboxProvider, getDocker, SANDBOX_NETWORK } from "@rivet/sandbox";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_IMAGE } from "../../src/config";
import { repoRoot, resolveIntegrationEnv } from "../integration/env";

/**
 * Acceptance run G: the container cannot reach the control plane.
 *
 * The half of this file that makes it worth having is the positive controls.
 * A connect helper that is broken - wrong argv, wrong Node API, a typo in a
 * hostname - fails every target identically, and a test of four failing
 * connects passes exactly as happily against a helper that cannot connect to
 * anything at all. So every negative here is paired with a positive that runs
 * through the same helper, in the same container, in the same run.
 *
 * Be exact about the claim. What is asserted is that the endpoints this worker
 * is *configured with* are unreachable from a job container, that two sandboxes
 * cannot talk to each other, and that the Docker socket is not in there.
 *
 * What is deliberately **not** asserted is that the host is unroutable, because
 * it is not. On Docker Desktop the host answers on `host.docker.internal` and
 * on a raw address, and reaches services bound to the host's own loopback; the
 * container drops `ALL` capabilities, so nothing inside it can filter routes
 * either. Pinning the aliases away was tried and reverted - it removed the
 * convenient path rather than the path, and this suite's own fixtures clone
 * from a git daemon on the host through exactly that route. Closing it needs
 * the egress control M11 scopes out. `docs/security-review.md` §6.9 records it
 * as an accepted risk instead of this file pretending otherwise.
 */

resolveIntegrationEnv();

const WORKER_ENTRYPOINT = resolve(repoRoot(), "apps/worker/src/index.ts");
const SIBLING_PORT = 7777;

/**
 * One TCP connect, reported as a word rather than an exit code.
 *
 * A refusal and a timeout are both "unreachable" and the distinction is worth
 * keeping in the output: a dropped packet (`enable_icc=false`) times out where
 * a closed port refuses, so a case that starts timing out when it used to
 * refuse has had its mechanism change underneath it.
 */
const CONNECT_SCRIPT = [
  'const net = require("node:net");',
  "const [host, port] = process.argv.slice(1);",
  "const socket = net.createConnection({ host, port: Number(port) });",
  "let settled = false;",
  "const finish = (verdict) => {",
  "  if (settled) return;",
  "  settled = true;",
  "  socket.destroy();",
  "  process.stdout.write(verdict);",
  "  process.exit(0);",
  "};",
  "socket.setTimeout(5000);",
  'socket.once("connect", () => finish("reachable"));',
  'socket.once("timeout", () => finish("unreachable:timeout"));',
  'socket.once("error", (error) => finish("unreachable:" + (error.code ?? "error")));',
].join("\n");

const LISTENER_SCRIPT = [
  'const net = require("node:net");',
  'net.createServer((socket) => socket.end("rivet-sibling\\n")).listen(',
  `  ${SIBLING_PORT},`,
  '  "0.0.0.0",',
  ");",
].join("\n");

const controller = new AbortController();
const provider = new DockerSandboxProvider({
  workerId: `network-isolation-${process.pid}`,
  reapGraceMs: 0,
});
const owned = new Set<Sandbox>();

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    jobId: randomUUID(),
    image: process.env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
    workdir: "/home/node/workspace",
    memoryBytes: 256 * 1_024 * 1_024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 64,
    env: {},
    labels: {},
    ...overrides,
  };
}

async function create(): Promise<Sandbox> {
  const sandbox = await provider.create(spec(), controller.signal);
  owned.add(sandbox);
  return sandbox;
}

async function connect(sandbox: Sandbox, host: string, port: number): Promise<string> {
  const result = await sandbox.exec({
    argv: ["node", "-e", CONNECT_SCRIPT, host, String(port)],
    cwd: "/home/node/workspace",
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  return result.stdout.trim();
}

/** The address a container would use for this endpoint, as the worker has it configured. */
function endpoint(name: "DATABASE_URL" | "REDIS_URL"): { host: string; port: number } {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the network isolation suite.`);
  const url = new URL(value);
  const fallback = name === "DATABASE_URL" ? 5432 : 6379;
  return { host: url.hostname, port: url.port.length > 0 ? Number(url.port) : fallback };
}

async function containerAddress(sandbox: Sandbox): Promise<string> {
  const info = (await getDocker().getContainer(sandbox.id).inspect()) as {
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  };
  const address = info.NetworkSettings?.Networks?.[SANDBOX_NETWORK]?.IPAddress;
  if (!address) throw new Error(`Container ${sandbox.id} has no address on ${SANDBOX_NETWORK}.`);
  return address;
}

afterEach(async () => {
  await Promise.all([...owned].map((sandbox) => sandbox.destroy()));
  owned.clear();
});

afterAll(async () => {
  await closeDb();
});

describe("sandbox network isolation", () => {
  it("reaches the internet and not the configured control plane, from one container", async () => {
    const sandbox = await create();

    // Positive controls first, and asserted first. If these fail the helper is
    // broken and every negative below is meaningless, so the failure must
    // arrive here rather than being read as isolation working.
    expect(await connect(sandbox, "registry.npmjs.org", 443)).toBe("reachable");
    expect(await connect(sandbox, "github.com", 443)).toBe("reachable");

    const database = endpoint("DATABASE_URL");
    const redis = endpoint("REDIS_URL");

    expect(await connect(sandbox, database.host, database.port)).toMatch(/^unreachable:/);
    expect(await connect(sandbox, redis.host, redis.port)).toMatch(/^unreachable:/);
  });

  it("has no Docker socket to escalate through", async () => {
    const sandbox = await create();

    // The positive control is the same `test -e` against a path the image
    // certainly has, so a shell that cannot stat anything cannot be mistaken
    // for a container with no socket in it.
    const present = await sandbox.exec({
      argv: ["test", "-e", "/etc/hostname"],
      cwd: "/home/node/workspace",
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    const socket = await sandbox.exec({
      argv: ["test", "-e", "/var/run/docker.sock"],
      cwd: "/home/node/workspace",
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    expect(present.exitCode).toBe(0);
    expect(socket.exitCode).not.toBe(0);
  });

  it("cannot reach a sibling container on the sandbox network", async () => {
    const listener = await create();
    const client = await create();

    await listener.putFile("/home/node/workspace/listen.js", LISTENER_SCRIPT, controller.signal);
    await listener.exec({
      argv: ["sh", "-c", "node /home/node/workspace/listen.js & sleep 1"],
      cwd: "/home/node/workspace",
      timeoutMs: 15_000,
      signal: controller.signal,
    });

    // The positive control for this case is the listener answering itself. It
    // separates "enable_icc=false dropped the packet" from "the listener never
    // came up", which are the same observation from the client's side.
    expect(await connect(listener, "127.0.0.1", SIBLING_PORT)).toBe("reachable");

    const address = await containerAddress(listener);
    expect(await connect(client, address, SIBLING_PORT)).toMatch(/^unreachable:/);
  });

  it("refuses to boot when a configured endpoint answers from inside the sandbox", async () => {
    // github.com:443 stands in for an exposed Postgres, and the first case in
    // this file is what makes that substitution honest: the probe is a TCP
    // connect, and that endpoint is proven reachable from the same network in
    // the same run. Pointing at a real exposed database would mean binding one
    // to an address CI and a laptop disagree about.
    const exposed = "postgresql://rivet:rivet@github.com:443/rivet_test";
    const result = await runWorker({ DATABASE_URL: exposed });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("DATABASE_URL");
    expect(result.output).toContain("refusing to start");
  }, 120_000);
});

/** Runs the real worker entrypoint far enough to reach the startup probe. */
function runWorker(
  overrides: Record<string, string>,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("pnpm", ["exec", "tsx", WORKER_ENTRYPOINT], {
      cwd: resolve(repoRoot(), "apps/worker"),
      env: {
        ...process.env,
        NODE_ENV: "test",
        RIVET_SANDBOX: "docker",
        RIVET_AGENT: "off",
        RIVET_TELEMETRY: "off",
        RIVET_GITHUB: "off",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

    // A worker that gets past the probe would run forever, and "the test timed
    // out" is a much worse report than "it booted when it should have refused".
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`The worker did not exit within 90s. Output:\n${output}`));
    }, 90_000);

    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      clearTimeout(guard);
      resolvePromise({ exitCode: code, output });
    });
  });
}
