import { TraceFlags } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";

import { formatTraceParent, parseTraceParent } from "./trace-context";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

describe("formatTraceParent", () => {
  it("writes the W3C form the spec's own example uses", () => {
    expect(
      formatTraceParent({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }),
    ).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it("reports an unsampled span as unsampled", () => {
    expect(
      formatTraceParent({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.NONE }),
    ).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`);
  });
});

describe("parseTraceParent", () => {
  it("round-trips what formatTraceParent produced", () => {
    const spanContext = { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED };
    expect(parseTraceParent(formatTraceParent(spanContext))).toEqual({
      ...spanContext,
      // Remote, because it came from another process - which is the entire
      // reason `jobs.trace_context` is a column rather than an object.
      isRemote: true,
    });
  });

  it("tolerates surrounding whitespace, which a database column collects", () => {
    expect(parseTraceParent(`  00-${TRACE_ID}-${SPAN_ID}-01  `)?.traceId).toBe(TRACE_ID);
  });

  it("returns undefined rather than throwing on anything malformed", () => {
    // Every one of these is a string that could plausibly be read back out of
    // `jobs.trace_context`, and none of them may fail a job. A link that cannot
    // be drawn is a missing link, not a failed run.
    for (const bad of [
      "",
      "nonsense",
      `01-${TRACE_ID}-${SPAN_ID}-01`,
      `00-${TRACE_ID}-${SPAN_ID}`,
      `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`,
      `00-${TRACE_ID.slice(1)}-${SPAN_ID}-01`,
      `00-${TRACE_ID}-${SPAN_ID}-01-extra`,
    ]) {
      expect(parseTraceParent(bad), bad).toBeUndefined();
    }
  });

  it("rejects the all-zero ids the spec defines as invalid", () => {
    expect(parseTraceParent(`00-${"0".repeat(32)}-${SPAN_ID}-01`)).toBeUndefined();
    expect(parseTraceParent(`00-${TRACE_ID}-${"0".repeat(16)}-01`)).toBeUndefined();
  });
});
