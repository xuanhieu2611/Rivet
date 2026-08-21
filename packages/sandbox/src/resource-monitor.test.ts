import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  METRIC_SANDBOX_CPU_PEAK,
  METRIC_SANDBOX_CPU_PEAK_DISTRIBUTION,
  METRIC_SANDBOX_MEMORY_PEAK,
  METRIC_SANDBOX_MEMORY_PEAK_DISTRIBUTION,
  METRIC_SANDBOX_MEMORY_USAGE,
  METRIC_SANDBOX_OOM_KILLS,
  METRIC_SANDBOX_PIDS_PEAK,
  RecordingTelemetry,
} from "@rivet/core";

import { SandboxResourceMonitor } from "./resource-monitor";

const SPEC = {
  memoryBytes: 512 * 1_024 * 1_024,
  nanoCpus: 2_000_000_000,
  pidsLimit: 64,
};

afterEach(() => vi.useRealTimers());

function stats(input: {
  memory: number;
  cpu: number;
  previousCpu: number;
  system: number;
  previousSystem: number;
  pids: number;
}): Docker.ContainerStats {
  return {
    memory_stats: { usage: input.memory } as Docker.MemoryStats,
    cpu_stats: {
      cpu_usage: { total_usage: input.cpu } as Docker.CPUUsage,
      system_cpu_usage: input.system,
      online_cpus: 2,
    } as Docker.CPUStats,
    precpu_stats: {
      cpu_usage: { total_usage: input.previousCpu } as Docker.CPUUsage,
      system_cpu_usage: input.previousSystem,
      online_cpus: 2,
    } as Docker.CPUStats,
    pids_stats: { current: input.pids },
    num_procs: input.pids,
  } as Docker.ContainerStats;
}

function container(samples: Docker.ContainerStats[], oomKilled = false): Docker.Container {
  let last = samples.at(-1);
  const stats = vi.fn(() => {
    last = samples.shift() ?? last;
    return Promise.resolve(last);
  });
  const inspect = vi.fn(() => Promise.resolve({ State: { OOMKilled: oomKilled } }));
  return { stats, inspect } as unknown as Docker.Container;
}

describe("SandboxResourceMonitor", () => {
  it("keeps peaks, reports when they occurred, and emits gauges plus distributions", async () => {
    vi.useFakeTimers();
    let now = 0;
    const telemetry = new RecordingTelemetry();
    const monitor = new SandboxResourceMonitor({
      container: container([
        stats({ memory: 100, cpu: 0, previousCpu: 0, system: 100, previousSystem: 100, pids: 4 }),
        stats({
          memory: 300,
          cpu: 150,
          previousCpu: 50,
          system: 1_100,
          previousSystem: 100,
          pids: 9,
        }),
      ]),
      spec: SPEC,
      workerId: "worker-1",
      telemetry,
      sampleIntervalMs: 5,
      now: () => now,
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(1);
    now = 100;
    await vi.advanceTimersByTimeAsync(10);
    const report = await monitor.report();
    vi.useRealTimers();

    expect(report.sampleCount).toBeGreaterThanOrEqual(2);
    expect(report).toMatchObject({
      version: 1,
      samplingErrors: 0,
      inspectionErrors: 0,
      durationMs: 100,
      memory: { peakBytes: 300, limitBytes: SPEC.memoryBytes, peakAtMs: 100 },
      // (150 - 50) / (1100 - 100) * 2 CPUs * 100.
      cpu: { peakPercent: 20, limitNanoCpus: SPEC.nanoCpus, peakAtMs: 100 },
      pids: { peak: 9, limit: SPEC.pidsLimit, peakAtMs: 100 },
      oomKilled: false,
    });
    expect(telemetry.measurementsNamed(METRIC_SANDBOX_MEMORY_USAGE).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(telemetry.measurementsNamed(METRIC_SANDBOX_MEMORY_PEAK)).toEqual([
      expect.objectContaining({ kind: "gauge", value: 300 }),
    ]);
    expect(telemetry.measurementsNamed(METRIC_SANDBOX_MEMORY_PEAK_DISTRIBUTION)).toEqual([
      expect.objectContaining({ kind: "histogram", value: 300 }),
    ]);
    expect(telemetry.measurementsNamed(METRIC_SANDBOX_CPU_PEAK_DISTRIBUTION)).toEqual([
      expect.objectContaining({ value: 20 }),
    ]);
    expect(telemetry.measurementsNamed(METRIC_SANDBOX_CPU_PEAK)).toHaveLength(1);
    expect(telemetry.measurementsNamed(METRIC_SANDBOX_PIDS_PEAK)).toHaveLength(1);
    expect(await monitor.report()).toBe(report);
  });

  it("keeps sampling failures visible without failing report collection", async () => {
    let now = 10;
    const errors: unknown[] = [];
    const docker = container([]);
    const statsCall = vi.spyOn(docker, "stats").mockRejectedValueOnce(new Error("daemon busy"));
    const telemetry = new RecordingTelemetry();
    const monitor = new SandboxResourceMonitor({
      container: docker,
      spec: SPEC,
      workerId: "worker-2",
      telemetry,
      now: () => now,
      onSampleError: (error) => errors.push(error),
    });

    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 1));
    now = 20;
    const report = await monitor.report();

    expect(statsCall).toHaveBeenCalled();
    expect(report).toMatchObject({
      sampleCount: 0,
      samplingErrors: 1,
      inspectionErrors: 0,
      memory: { peakBytes: null },
      cpu: { peakPercent: null },
      pids: { peak: null },
    });
    expect(errors).toHaveLength(1);
    expect(telemetry.measurementsNamed(METRIC_SANDBOX_OOM_KILLS)).toEqual([]);
  });

  it("records the container's OOM state once at teardown", async () => {
    const telemetry = new RecordingTelemetry();
    const monitor = new SandboxResourceMonitor({
      container: container(
        [stats({ memory: 128, cpu: 0, previousCpu: 0, system: 0, previousSystem: 0, pids: 2 })],
        true,
      ),
      spec: SPEC,
      workerId: "worker-3",
      telemetry,
      sampleIntervalMs: 10,
    });

    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 1));
    const report = await monitor.report();

    expect(report.oomKilled).toBe(true);
    expect(telemetry.total(METRIC_SANDBOX_OOM_KILLS)).toBe(1);
  });
});
