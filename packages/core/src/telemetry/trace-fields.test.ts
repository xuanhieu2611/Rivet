import { describe, expect, it } from "vitest";

import { traceFields } from "./trace-fields";

describe("traceFields", () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const spanId = "00f067aa0ba902b7";

  it("splits a valid traceparent into the two ids a log line carries", () => {
    expect(traceFields(`00-${traceId}-${spanId}-01`)).toEqual({
      trace_id: traceId,
      span_id: spanId,
    });
  });

  it("tolerates surrounding whitespace from a database column", () => {
    expect(traceFields(`  00-${traceId}-${spanId}-00  `)).toEqual({
      trace_id: traceId,
      span_id: spanId,
    });
  });

  it("returns undefined rather than blank fields when there is nothing to correlate", () => {
    expect(traceFields(undefined)).toBeUndefined();
    expect(traceFields("")).toBeUndefined();
  });

  it("refuses a malformed or unsupported traceparent", () => {
    expect(traceFields("not-a-traceparent")).toBeUndefined();
    expect(traceFields(`01-${traceId}-${spanId}-01`)).toBeUndefined();
    expect(traceFields(`00-${traceId.toUpperCase()}-${spanId}-01`)).toBeUndefined();
    expect(traceFields(`00-${traceId}-${spanId}`)).toBeUndefined();
  });

  it("refuses the all-zero ids, which point at nothing while looking findable", () => {
    expect(traceFields(`00-${"0".repeat(32)}-${spanId}-01`)).toBeUndefined();
    expect(traceFields(`00-${traceId}-${"0".repeat(16)}-01`)).toBeUndefined();
  });
});
