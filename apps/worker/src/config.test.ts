import { describe, expect, it } from "vitest";

import {
  assertLeaseInvariant,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_WORKDIR,
  parseWorkerConfig,
  WorkerConfigError,
} from "./config";

describe("parseWorkerConfig", () => {
  it("applies every default for an empty environment", () => {
    expect(parseWorkerConfig({})).toEqual({
      concurrency: 2,
      leaseSeconds: 30,
      heartbeatSeconds: 10,
      sweepIntervalMs: 60_000,
      maxAttempts: 3,
      pipelineSpeed: 1,
      shutdownGraceMs: 15_000,
      logLevel: "info",
      sandbox: {
        mode: "docker",
        image: DEFAULT_SANDBOX_IMAGE,
        workdir: DEFAULT_SANDBOX_WORKDIR,
        memoryBytes: 2_048 * 1_024 * 1_024,
        nanoCpus: 2_000_000_000,
        pidsLimit: 512,
        commandTimeoutMs: 120_000,
        cloneTimeoutMs: 180_000,
        installTimeoutMs: 300_000,
        baselineTimeoutMs: 300_000,
        maxOutputBytes: 65_536,
      },
    });
  });

  it("defaults to a real sandbox, so simulation is always a decision", () => {
    // The Milestone 1 pipeline is still in the codebase and still works. It is
    // reachable only by asking for it, because a default that happens to be
    // fake is the kind of thing that survives into a deployment.
    expect(parseWorkerConfig({}).sandbox.mode).toBe("docker");
  });

  it("pins the image by digest as well as by tag", () => {
    // A tag is what a human reads; the digest is what stops an upstream retag
    // silently changing what a job runs.
    expect(DEFAULT_SANDBOX_IMAGE).toContain("@sha256:");
  });

  it("converts the sandbox limits into the units Docker wants", () => {
    const config = parseWorkerConfig({
      SANDBOX_MEMORY_MB: "512",
      // Fractional on purpose: half a core is a reasonable ask and NanoCpus is
      // an integer.
      SANDBOX_CPUS: "0.5",
      SANDBOX_PIDS_LIMIT: "64",
    });

    expect(config.sandbox.memoryBytes).toBe(536_870_912);
    expect(config.sandbox.nanoCpus).toBe(500_000_000);
    expect(config.sandbox.pidsLimit).toBe(64);
  });

  it("gives the clone, the install and the baseline budgets of their own", () => {
    // Three different kinds of slow. A cold install and a four-minute test
    // suite are both normal; reporting either as `command_timed_out` would
    // blame the sandbox for a property of the repository.
    const config = parseWorkerConfig({
      SANDBOX_COMMAND_TIMEOUT_MS: "1000",
      SANDBOX_CLONE_TIMEOUT_MS: "2000",
      SANDBOX_INSTALL_TIMEOUT_MS: "3000",
      SANDBOX_BASELINE_TIMEOUT_MS: "4000",
    });

    expect(config.sandbox.commandTimeoutMs).toBe(1_000);
    expect(config.sandbox.cloneTimeoutMs).toBe(2_000);
    expect(config.sandbox.installTimeoutMs).toBe(3_000);
    expect(config.sandbox.baselineTimeoutMs).toBe(4_000);
  });

  it("refuses a workdir that is not absolute", () => {
    // It is passed straight to `mkdir -p` and to every `cwd` in the run.
    expect(() => parseWorkerConfig({ SANDBOX_WORKDIR: "workspace" })).toThrow(WorkerConfigError);
  });

  it("refuses to simulate the pipeline in production", () => {
    // A worker that completes every job in twenty-one seconds without doing
    // anything looks entirely healthy, which is the worst failure mode
    // available. Refusing to boot is the cheap version of that conversation.
    expect(() => parseWorkerConfig({ RIVET_SANDBOX: "off", NODE_ENV: "production" })).toThrow(
      WorkerConfigError,
    );
    expect(() => parseWorkerConfig({ RIVET_SANDBOX: "off", NODE_ENV: "production" })).toThrow(
      /RIVET_SANDBOX=off/,
    );
  });

  it("allows the simulated pipeline everywhere else", () => {
    // Including with no NODE_ENV at all, which is how the integration suite and
    // a laptop with no daemon run.
    expect(parseWorkerConfig({ RIVET_SANDBOX: "off" }).sandbox.mode).toBe("off");
    expect(parseWorkerConfig({ RIVET_SANDBOX: "off", NODE_ENV: "test" }).sandbox.mode).toBe("off");
  });

  it("rejects a sandbox mode that is not one of the two", () => {
    expect(() => parseWorkerConfig({ RIVET_SANDBOX: "podman" })).toThrow(WorkerConfigError);
  });

  it("reads values from the environment", () => {
    const config = parseWorkerConfig({
      WORKER_CONCURRENCY: "4",
      WORKER_LEASE_SECONDS: "60",
      WORKER_HEARTBEAT_SECONDS: "5",
      RIVET_PIPELINE_SPEED: "0",
      LOG_LEVEL: "debug",
    });

    expect(config.concurrency).toBe(4);
    expect(config.leaseSeconds).toBe(60);
    expect(config.heartbeatSeconds).toBe(5);
    expect(config.pipelineSpeed).toBe(0);
    expect(config.logLevel).toBe("debug");
  });

  it("treats an empty string as unset rather than as zero", () => {
    // A `.env` file with blank placeholders is normal, and Zod's coercion would
    // otherwise read `WORKER_CONCURRENCY=""` as a concurrency of 0.
    expect(parseWorkerConfig({ WORKER_CONCURRENCY: "", LOG_LEVEL: "" }).concurrency).toBe(2);
  });

  it("rejects a heartbeat that cannot keep the lease alive", () => {
    // The invariant this whole file exists for. A 15s heartbeat against a 30s
    // lease means one missed beat is survivable and two are not, so the sweeper
    // would reclaim jobs from a worker that is doing nothing wrong.
    expect(() =>
      parseWorkerConfig({ WORKER_HEARTBEAT_SECONDS: "15", WORKER_LEASE_SECONDS: "30" }),
    ).toThrow(WorkerConfigError);

    expect(() =>
      parseWorkerConfig({ WORKER_HEARTBEAT_SECONDS: "90", WORKER_LEASE_SECONDS: "30" }),
    ).toThrow(/must be at most/);
  });

  it("accepts a heartbeat exactly at the limit", () => {
    const config = parseWorkerConfig({
      WORKER_HEARTBEAT_SECONDS: "10",
      WORKER_LEASE_SECONDS: "30",
    });
    expect(config.heartbeatSeconds * 3).toBe(config.leaseSeconds);
  });

  it("rejects values that are not numbers", () => {
    expect(() => parseWorkerConfig({ WORKER_CONCURRENCY: "lots" })).toThrow(WorkerConfigError);
  });

  it("rejects a fractional or non-positive concurrency", () => {
    expect(() => parseWorkerConfig({ WORKER_CONCURRENCY: "2.5" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ WORKER_CONCURRENCY: "0" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ WORKER_CONCURRENCY: "-1" })).toThrow(WorkerConfigError);
  });

  it("reads the sweeper's knobs", () => {
    const config = parseWorkerConfig({
      WORKER_SWEEP_INTERVAL_MS: "5000",
      WORKER_MAX_ATTEMPTS: "5",
    });

    expect(config.sweepIntervalMs).toBe(5_000);
    expect(config.maxAttempts).toBe(5);
  });

  it("reads every fault mode when both halves are set", () => {
    for (const mode of ["throw", "fatal", "hang", "exit", "no-daemon", "oom", "slow-command"]) {
      const config = parseWorkerConfig({ RIVET_FAULT_PHASE: "testing", RIVET_FAULT_MODE: mode });
      expect(config.fault).toEqual({ phase: "testing", mode });
    }
  });

  it("leaves the fault absent when neither half is set", () => {
    expect(parseWorkerConfig({}).fault).toBeUndefined();
    // Blank placeholders in a `.env` file are the normal way this arrives.
    expect(
      parseWorkerConfig({ RIVET_FAULT_PHASE: "", RIVET_FAULT_MODE: "" }).fault,
    ).toBeUndefined();
  });

  it("rejects a half-configured fault", () => {
    // Both single-variable mistakes are silent otherwise: a mode with no phase
    // would break an unpredictable phase, and a phase with no mode would look
    // armed while doing nothing.
    expect(() => parseWorkerConfig({ RIVET_FAULT_PHASE: "testing" })).toThrow(WorkerConfigError);
    expect(() => parseWorkerConfig({ RIVET_FAULT_MODE: "fatal" })).toThrow(/must be set together/);
  });

  it("rejects an unknown fault mode", () => {
    expect(() =>
      parseWorkerConfig({ RIVET_FAULT_PHASE: "testing", RIVET_FAULT_MODE: "explode" }),
    ).toThrow(WorkerConfigError);
  });

  it("rejects an unknown log level", () => {
    expect(() => parseWorkerConfig({ LOG_LEVEL: "chatty" })).toThrow(WorkerConfigError);
  });

  it("reports every problem at once, not one per restart", () => {
    try {
      parseWorkerConfig({ WORKER_CONCURRENCY: "nope", LOG_LEVEL: "chatty" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerConfigError);
      expect((error as WorkerConfigError).problems).toHaveLength(2);
    }
  });
});

describe("assertLeaseInvariant", () => {
  it("accepts the defaults", () => {
    expect(() => assertLeaseInvariant(10, 30)).not.toThrow();
  });

  it("accepts a heartbeat with room to spare", () => {
    expect(() => assertLeaseInvariant(2, 30)).not.toThrow();
  });

  it("rejects anything that leaves fewer than three heartbeats of slack", () => {
    expect(() => assertLeaseInvariant(11, 30)).toThrow(WorkerConfigError);
  });
});
