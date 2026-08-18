/**
 * A `traceparent`, as the two ids a log line carries.
 *
 * This is the whole of "logs join the trace rather than being replaced by it"
 * (`docs/plans/milestone-11.md` §3). Both deployables put `trace_id` and
 * `span_id` on every pino line through a mixin, and both need the same three
 * lines of parsing to do it - so it lives here, next to the port that defines
 * trace context as a W3C `traceparent` string in the first place, rather than
 * twice.
 *
 * `packages/telemetry` has a richer parser (`parseTraceParent`) that returns an
 * SDK `SpanContext`. This is deliberately not that: a logger must not depend on
 * the OpenTelemetry adapter, or `RIVET_TELEMETRY=off` would still drag an SDK
 * into the process, and the web app's logger would drag one into a bundle.
 *
 * The field names are snake_case rather than the codebase's camelCase because
 * they are not Rivet's names. `trace_id` and `span_id` are what Grafana, Loki
 * and the OTel log data model look for, and a renamed field is a correlation
 * that silently does not happen.
 */

export interface TraceFields {
  trace_id: string;
  span_id: string;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

/**
 * The two ids, or `undefined` when there is nothing to correlate.
 *
 * `undefined` rather than blank fields, because the mixin spreads the result:
 * an absent key leaves the line as it was, and `trace_id: ""` would put an
 * empty bucket in every group-by over a system whose default is telemetry off.
 */
export function traceFields(traceparent: string | undefined): TraceFields | undefined {
  if (!traceparent) return undefined;

  const match = TRACEPARENT.exec(traceparent.trim());
  if (!match) return undefined;

  const [, trace_id, span_id] = match as unknown as [string, string, string];
  // The all-zero ids are what the spec defines as invalid. A log line pointing
  // at them is worse than one pointing at nothing, because it looks findable.
  if (trace_id === INVALID_TRACE_ID || span_id === INVALID_SPAN_ID) return undefined;

  return { trace_id, span_id };
}
