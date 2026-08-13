import { describe, expect, it } from "vitest";

import { assertLeaseInvariant, parseWorkerConfig, WorkerConfigError } from "./config";

describe("parseWorkerConfig", () => {
  it("applies every default for an empty environment", () => {
    expect(parseWorkerConfig({})).toEqual({
      concurrency: 2,
      leaseSeconds: 30,
      heartbeatSeconds: 10,
      pipelineSpeed: 1,
      shutdownGraceMs: 15_000,
      logLevel: "info",
    });
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
