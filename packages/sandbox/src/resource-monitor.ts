import type Docker from "dockerode";
import type { Container } from "dockerode";

import {
  ATTR_WORKER_ID,
  METRIC_SANDBOX_CPU_PEAK,
  METRIC_SANDBOX_CPU_PEAK_DISTRIBUTION,
  METRIC_SANDBOX_CPU_USAGE,
  METRIC_SANDBOX_MEMORY_PEAK,
  METRIC_SANDBOX_MEMORY_PEAK_DISTRIBUTION,
  METRIC_SANDBOX_MEMORY_USAGE,
  METRIC_SANDBOX_OOM_KILLS,
  METRIC_SANDBOX_PIDS_PEAK,
  METRIC_SANDBOX_PIDS_PEAK_DISTRIBUTION,
  METRIC_SANDBOX_PIDS_USAGE,
  NOOP_TELEMETRY,
  type SandboxResourceReport,
  type SandboxSpec,
  type Telemetry,
} from "@rivet/core";

/** The Docker stats shape returned by `container.stats({ stream: false })`. */
type ContainerStats = Docker.ContainerStats;

const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

export interface SandboxResourceMonitorOptions {
  container: Container;
  spec: Pick<SandboxSpec, "memoryBytes" | "nanoCpus" | "pidsLimit">;
  workerId: string;
  telemetry?: Telemetry;
  /** Injectable for adapter tests; production samples once per second. */
  sampleIntervalMs?: number;
  now?: () => number;
  onSampleError?: (error: unknown) => void;
}

interface Peak<T> {
  value: T | null;
  atMs: number | null;
}

/**
 * Samples one running container without creating a second durable log.
 *
 * Docker's stats endpoint is polled rather than opened as a streaming response:
 * one request per interval is bounded, easy to stop during cleanup, and does
 * not leave a socket waiting behind a killed worker. The monitor never throws
 * for a failed sample. A missing observation is evidence in the report, not a
 * reason to turn an otherwise valid job into an infrastructure failure.
 */
export class SandboxResourceMonitor {
  private readonly container: Container;
  private readonly memoryLimitBytes: number;
  private readonly cpuLimitNanoCpus: number;
  private readonly pidsLimit: number;
  private readonly workerId: string;
  private readonly telemetry: Telemetry;
  private readonly sampleIntervalMs: number;
  private readonly now: () => number;
  private readonly onSampleError: (error: unknown) => void;

  private startedAt: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private reportPromise: Promise<SandboxResourceReport> | undefined;
  private stopped = false;
  private sampleCount = 0;
  private samplingErrors = 0;
  private inspectionErrors = 0;
  private readonly memoryPeak: Peak<number> = { value: null, atMs: null };
  private readonly cpuPeak: Peak<number> = { value: null, atMs: null };
  private readonly pidsPeak: Peak<number> = { value: null, atMs: null };

  constructor(options: SandboxResourceMonitorOptions) {
    this.container = options.container;
    this.memoryLimitBytes = options.spec.memoryBytes;
    this.cpuLimitNanoCpus = options.spec.nanoCpus;
    this.pidsLimit = options.spec.pidsLimit;
    this.workerId = options.workerId;
    this.telemetry = options.telemetry ?? NOOP_TELEMETRY;
    this.sampleIntervalMs = normalizeInterval(options.sampleIntervalMs);
    this.now = options.now ?? Date.now;
    this.onSampleError = options.onSampleError ?? (() => undefined);
  }

  /** Starts the interval and takes one immediate sample. Idempotent. */
  start(): void {
    if (this.startedAt !== undefined) return;
    this.startedAt = this.now();
    this.scheduleSample();
    this.timer = setInterval(() => this.scheduleSample(), this.sampleIntervalMs);
    this.timer.unref?.();
  }

  /** Stops sampling and returns one immutable report for the sandbox lifetime. */
  report(): Promise<SandboxResourceReport> {
    this.reportPromise ??= this.finish();
    return this.reportPromise;
  }

  private scheduleSample(): void {
    if (this.stopped || this.inFlight !== undefined) return;

    const sample = this.sample();
    this.inFlight = sample;
    void sample.finally(() => {
      if (this.inFlight === sample) this.inFlight = undefined;
    });
  }

  private async sample(): Promise<void> {
    try {
      const stats = await this.container.stats({ stream: false });
      this.record(stats);
    } catch (error) {
      this.samplingErrors += 1;
      this.onSampleError(error);
    }
  }

  private record(stats: ContainerStats): void {
    const elapsedMs = this.elapsedMs();
    this.sampleCount += 1;

    const memoryBytes = finiteNonNegative(stats.memory_stats?.usage);
    const cpuPercent = cpuPercentOf(stats);
    const pids = finiteNonNegative(stats.pids_stats?.current ?? stats.num_procs);

    if (memoryBytes !== null) {
      updatePeak(this.memoryPeak, memoryBytes, elapsedMs);
      recordGauge(
        this.telemetry,
        METRIC_SANDBOX_MEMORY_USAGE,
        memoryBytes,
        "By",
        "Current sandbox memory usage.",
        this.workerId,
      );
    }
    if (cpuPercent !== null) {
      updatePeak(this.cpuPeak, cpuPercent, elapsedMs);
      recordGauge(
        this.telemetry,
        METRIC_SANDBOX_CPU_USAGE,
        cpuPercent,
        "%",
        "Current sandbox CPU usage as a percentage of host CPU capacity.",
        this.workerId,
      );
    }
    if (pids !== null) {
      updatePeak(this.pidsPeak, pids, elapsedMs);
      recordGauge(
        this.telemetry,
        METRIC_SANDBOX_PIDS_USAGE,
        pids,
        "1",
        "Current number of processes in the sandbox.",
        this.workerId,
      );
    }
  }

  private async finish(): Promise<SandboxResourceReport> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;

    const oomKilled = await this.readOomState();
    const report: SandboxResourceReport = {
      version: 1,
      samplingIntervalMs: this.sampleIntervalMs,
      sampleCount: this.sampleCount,
      samplingErrors: this.samplingErrors,
      inspectionErrors: this.inspectionErrors,
      durationMs: this.elapsedMs(),
      memory: {
        peakBytes: this.memoryPeak.value,
        limitBytes: this.memoryLimitBytes,
        peakAtMs: this.memoryPeak.atMs,
      },
      cpu: {
        peakPercent: this.cpuPeak.value,
        limitNanoCpus: this.cpuLimitNanoCpus,
        peakAtMs: this.cpuPeak.atMs,
      },
      pids: {
        peak: this.pidsPeak.value,
        limit: this.pidsLimit,
        peakAtMs: this.pidsPeak.atMs,
      },
      oomKilled,
      collectedAt: new Date(this.now()).toISOString(),
    };

    this.recordPeakMetrics(report);
    return report;
  }

  private async readOomState(): Promise<boolean> {
    try {
      const info = await this.container.inspect();
      return info.State?.OOMKilled === true;
    } catch (error) {
      this.inspectionErrors += 1;
      this.onSampleError(error);
      return false;
    }
  }

  private recordPeakMetrics(report: SandboxResourceReport): void {
    const attributes = { [ATTR_WORKER_ID]: this.workerId };
    if (report.memory.peakBytes !== null) {
      recordResourcePeak(
        this.telemetry,
        METRIC_SANDBOX_MEMORY_PEAK,
        METRIC_SANDBOX_MEMORY_PEAK_DISTRIBUTION,
        report.memory.peakBytes,
        "By",
        "Peak sandbox memory usage per container.",
        attributes,
      );
    }
    if (report.cpu.peakPercent !== null) {
      recordResourcePeak(
        this.telemetry,
        METRIC_SANDBOX_CPU_PEAK,
        METRIC_SANDBOX_CPU_PEAK_DISTRIBUTION,
        report.cpu.peakPercent,
        "%",
        "Peak sandbox CPU usage per container.",
        attributes,
      );
    }
    if (report.pids.peak !== null) {
      recordResourcePeak(
        this.telemetry,
        METRIC_SANDBOX_PIDS_PEAK,
        METRIC_SANDBOX_PIDS_PEAK_DISTRIBUTION,
        report.pids.peak,
        "1",
        "Peak sandbox process count per container.",
        attributes,
      );
    }
    if (report.oomKilled) {
      this.telemetry
        .counter(METRIC_SANDBOX_OOM_KILLS, {
          unit: "1",
          description: "Sandbox containers whose kernel state reports an OOM kill.",
        })
        .add(1, attributes);
    }
  }

  private elapsedMs(): number {
    return Math.max(0, this.now() - (this.startedAt ?? this.now()));
  }
}

function recordGauge(
  telemetry: Telemetry,
  name: string,
  value: number,
  unit: string,
  description: string,
  workerId: string,
): void {
  telemetry.gauge(name, { unit, description }).record(value, { [ATTR_WORKER_ID]: workerId });
}

function updatePeak(peak: Peak<number>, value: number, atMs: number): void {
  if (peak.value === null || value > peak.value) {
    peak.value = value;
    peak.atMs = atMs;
  }
}

function recordResourcePeak(
  telemetry: Telemetry,
  gaugeName: string,
  histogramName: string,
  value: number,
  unit: string,
  description: string,
  attributes: Record<string, string>,
): void {
  telemetry.gauge(gaugeName, { unit, description }).record(value, attributes);
  telemetry.histogram(histogramName, { unit, description }).record(value, attributes);
}

function cpuPercentOf(stats: ContainerStats): number | null {
  const cpuDelta =
    stats.cpu_stats?.cpu_usage?.total_usage - stats.precpu_stats?.cpu_usage?.total_usage;
  const systemDelta = stats.cpu_stats?.system_cpu_usage - stats.precpu_stats?.system_cpu_usage;
  const onlineCpus = stats.cpu_stats?.online_cpus;
  if (!Number.isFinite(cpuDelta) || !Number.isFinite(systemDelta) || systemDelta <= 0) return null;
  const cores = Number.isFinite(onlineCpus) && onlineCpus > 0 ? onlineCpus : 1;
  const percentage = (cpuDelta / systemDelta) * cores * 100;
  return Number.isFinite(percentage) && percentage >= 0 ? percentage : null;
}

function finiteNonNegative(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeInterval(intervalMs: number | undefined): number {
  if (intervalMs === undefined || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return DEFAULT_SAMPLE_INTERVAL_MS;
  }
  return Math.max(1, Math.floor(intervalMs));
}
