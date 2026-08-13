import {
  type ExecRequest,
  type Phase,
  type SandboxSpec,
  RetryableJobError,
  TerminalJobError,
} from "@rivet/core";
import { FakeSandboxProvider } from "@rivet/sandbox";
import { pino } from "pino";
import { describe, expect, it } from "vitest";

import { createFaultInjection } from "./faults";

const log = pino({ level: "silent" });

const TESTING: Phase = { status: "testing", label: "Run tests", durationMs: 10 };
const SANDBOX_TESTING: Phase = {
  status: "testing",
  label: "Run tests",
  durationMs: 10,
  run: () => Promise.resolve(),
};
const PLANNING: Phase = { status: "planning", label: "Create plan", durationMs: 10 };
const SPEC: SandboxSpec = {
  jobId: "11111111-1111-4111-8111-111111111111",
  image: "node@sha256:test",
  workdir: "/workspace",
  memoryBytes: 512 * 1_024 * 1_024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 128,
  env: {},
  labels: {},
};

function request(argv: string[], signal = new AbortController().signal): ExecRequest {
  return { argv, cwd: "/workspace", timeoutMs: 10, signal };
}

describe("createFaultInjection", () => {
  it("injects nothing when no fault is configured", () => {
    const injection = createFaultInjection(undefined, log);

    expect(injection.fault).toBeUndefined();
  });

  it("returns a retryable error at the named phase only", () => {
    const injection = createFaultInjection({ phase: "testing", mode: "throw" }, log);

    expect(injection.fault?.(PLANNING)).toBeUndefined();
    expect(injection.fault?.(TESTING)).toBeInstanceOf(RetryableJobError);
  });

  it("returns a terminal error carrying a real failure category", () => {
    const injection = createFaultInjection({ phase: "testing", mode: "fatal" }, log);

    const error = injection.fault?.(TESTING);
    expect(error).toBeInstanceOf(TerminalJobError);
    expect((error as TerminalJobError).category).toBe("repo_unavailable");
  });

  it("makes only the faulted phase deaf to its abort signal", async () => {
    const injection = createFaultInjection({ phase: "testing", mode: "hang" }, log);
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    // A phase that is not the faulted one still aborts normally, so the
    // timeline shows the run reaching the phase that wedged it.
    injection.fault?.(PLANNING);
    await expect(injection.sleep(1, controller.signal)).rejects.toThrow("stop");

    // The faulted one ignores the signal entirely, which is the whole point:
    // it is what the timeout, rather than the abort, has to catch.
    injection.fault?.(TESTING);
    const hung = injection.sleep(1, controller.signal);
    const raced = await Promise.race([
      hung.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("still hanging"), 20)),
    ]);
    expect(raced).toBe("still hanging");
  });

  it("makes no-daemon fail sandbox creation with a retryable category", async () => {
    const provider = new FakeSandboxProvider();
    const injection = createFaultInjection(
      { phase: "provisioning", mode: "no-daemon" },
      log,
      provider,
    );

    injection.fault?.({ status: "provisioning", label: "Provision", durationMs: 1 });
    await expect(
      injection.sandbox?.create(SPEC, new AbortController().signal),
    ).rejects.toMatchObject({ category: "sandbox_unavailable" });
  });

  it("makes slow-command exceed the command timeout inside a real phase", async () => {
    const provider = new FakeSandboxProvider({ script: [{ match: "sleep", hang: true }] });
    const injection = createFaultInjection(
      { phase: "testing", mode: "slow-command" },
      log,
      provider,
    );
    const sandbox = await injection.sandbox?.create(SPEC, new AbortController().signal);
    injection.fault?.(SANDBOX_TESTING);

    const result = await sandbox?.exec(request(["echo", "not-the-fault"]));
    expect(result?.argv[0]).toBe("sleep");
    expect(result?.timedOut).toBe(true);
    expect(result?.oomKilled).toBe(false);
  });

  it("makes oom run an allocation command and report an OOM kill", async () => {
    const provider = new FakeSandboxProvider({
      script: [
        {
          match: (argv) => argv[0] === "node" && argv[1] === "-e",
          hang: true,
          oomKilled: true,
        },
      ],
    });
    const injection = createFaultInjection({ phase: "testing", mode: "oom" }, log, provider);
    const sandbox = await injection.sandbox?.create(SPEC, new AbortController().signal);
    injection.fault?.(SANDBOX_TESTING);

    const result = await sandbox?.exec(request(["echo", "not-the-fault"]));
    expect(result?.argv[0]).toBe("node");
    expect(result?.oomKilled).toBe(true);
    expect(result?.timedOut).toBe(false);
  });
});
