import type { JobEventData } from "@rivet/contracts";

import type { SandboxResourceReport } from "./sandbox";

/** The artifact type is text, but its body is always complete JSON. */
export function serializeSandboxResourceReport(report: SandboxResourceReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/**
 * The small, flat index stored beside the report body.
 *
 * Artifact metadata is read without fetching content, so keep the facts a
 * timeline or dashboard needs here as well as in the complete JSON body.
 */
export function sandboxResourceReportMetadata(
  report: SandboxResourceReport,
): Record<string, unknown> {
  return {
    version: report.version,
    samplingIntervalMs: report.samplingIntervalMs,
    sampleCount: report.sampleCount,
    samplingErrors: report.samplingErrors,
    inspectionErrors: report.inspectionErrors,
    durationMs: report.durationMs,
    memoryPeakBytes: report.memory.peakBytes,
    memoryLimitBytes: report.memory.limitBytes,
    memoryPeakAtMs: report.memory.peakAtMs,
    cpuPeakPercent: report.cpu.peakPercent,
    cpuLimitNanoCpus: report.cpu.limitNanoCpus,
    cpuPeakAtMs: report.cpu.peakAtMs,
    pidsPeak: report.pids.peak,
    pidsLimit: report.pids.limit,
    pidsPeakAtMs: report.pids.peakAtMs,
    oomKilled: report.oomKilled,
  };
}

/** The event points to the complete artifact without copying its JSON body. */
export function sandboxResourceReportEventData(
  report: SandboxResourceReport,
  artifactId: number,
  byteSize: number,
  containerId?: string,
): JobEventData {
  const metadata = sandboxResourceReportMetadata(report);
  delete metadata.version;

  return {
    ...(containerId === undefined ? {} : { containerId }),
    artifactId,
    artifactType: "resource_report",
    byteSize,
    truncated: false,
    resourceReportVersion: report.version,
    ...metadata,
  };
}
