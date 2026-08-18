import { type SpanContext, TraceFlags } from "@opentelemetry/api";

/**
 * The two directions of a W3C `traceparent`, in one place.
 *
 * The port carries trace context as a string rather than as a `Span`, because
 * the span being referred to is generally over and in another process - that is
 * the whole reason `jobs.trace_context` is a `text` column. So the adapter is
 * the only code that has to know the wire format, and it needs it both ways:
 * `format` for `Span.traceContext()` and for the column, `parse` for turning a
 * stored context back into a `SpanLink`.
 *
 * Written out rather than reached for through `propagation.inject`, which would
 * need a carrier object, a registered global propagator and a `Context` to read
 * from - three pieces of ambient state to move one 55-character string.
 */

/** Version 00, the only one anything emits, and the only one accepted. */
const VERSION = "00";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

export function formatTraceParent(spanContext: SpanContext): string {
  const flags = (spanContext.traceFlags & TraceFlags.SAMPLED).toString(16).padStart(2, "0");
  return `${VERSION}-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

/**
 * A `traceparent` as a `SpanContext`, or `undefined` if it is not one.
 *
 * `undefined` rather than a throw, and this is the load-bearing half of the
 * decision. The strings this parses arrive from a Postgres column written by
 * some earlier process - possibly an older version of Rivet, possibly one whose
 * telemetry was off - and the only thing a caller does with the result is
 * attach a link. Failing a job because a link could not be drawn would make
 * telemetry able to change the outcome of a run, which is exactly what
 * acceptance run C says it must never do.
 *
 * The all-zero ids are rejected along with the malformed ones: they are what
 * the spec defines as invalid, and a link to them points at nothing.
 */
export function parseTraceParent(traceparent: string): SpanContext | undefined {
  const match = TRACEPARENT.exec(traceparent.trim());
  if (!match) return undefined;

  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return undefined;

  return {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16) & TraceFlags.SAMPLED,
    // A context that came in over the wire, which is what makes the SDK treat
    // it as remote for sampling and for `parentSpanId` bookkeeping.
    isRemote: true,
  };
}
