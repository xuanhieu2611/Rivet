import { describe, expect, it } from "vitest";

import {
  sandboxResourceReportEventData,
  sandboxResourceReportMetadata,
  serializeSandboxResourceReport,
} from "./resource-report";
import type { SandboxResourceReport } from "./sandbox";

const REPORT: SandboxResourceReport = {
  version: 1,
  samplingIntervalMs: 1_000,
  sampleCount: 4,
  samplingErrors: 1,
  inspectionErrors: 0,
  durationMs: 12_500,
  memory: { peakBytes: 12_345, limitBytes: 1_000_000, peakAtMs: 8_000 },
  cpu: { peakPercent: 83.5, limitNanoCpus: 500_000_000, peakAtMs: 7_000 },
  pids: { peak: 12, limit: 64, peakAtMs: 2_000 },
  oomKilled: true,
  collectedAt: "2026-01-01T00:00:00.000Z",
};

describe("sandbox resource reports", () => {
  it("serializes a complete, readable JSON artifact", () => {
    const content = serializeSandboxResourceReport(REPORT);

    expect(content.endsWith("\n")).toBe(true);
    const parsed: unknown = JSON.parse(content);
    expect(parsed).toEqual(REPORT);
  });

  it("keeps an index of peaks for metadata-only artifact reads", () => {
    expect(sandboxResourceReportMetadata(REPORT)).toMatchObject({
      sampleCount: 4,
      memoryPeakBytes: 12_345,
      cpuPeakPercent: 83.5,
      pidsPeak: 12,
      oomKilled: true,
    });
  });

  it("points the resource event at the complete artifact", () => {
    expect(sandboxResourceReportEventData(REPORT, 42, 900, "container-1")).toMatchObject({
      containerId: "container-1",
      artifactId: 42,
      artifactType: "resource_report",
      byteSize: 900,
      truncated: false,
      sampleCount: 4,
      oomKilled: true,
    });
  });
});
