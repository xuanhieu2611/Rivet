import {
  context as otelContext,
  type Attributes as OtelAttributes,
  type AttributeValue as OtelAttributeValue,
  type Counter as OtelCounter,
  type Gauge as OtelGauge,
  type Histogram as OtelHistogram,
  type Link,
  type Meter,
  type Span as OtelSpanApi,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import {
  type Attributes,
  type AttributeValue,
  compactAttributes,
  type Counter,
  describeError,
  type Gauge,
  type Histogram,
  type InstrumentOptions,
  runWithSpan,
  type Span,
  type SpanBody,
  type SpanKind,
  type SpanOptions,
  type SpanStatus,
  type Telemetry,
} from "@rivet/core";

import { formatTraceParent, parseTraceParent } from "./trace-context";

/**
 * The `Telemetry` port, implemented against OpenTelemetry.
 *
 * The one class in Rivet that knows both vocabularies. Everything above it -
 * every phase, the processor, the route handlers - talks to the port, which is
 * what lets acceptance run A assert a span tree in-process with no SDK and no
 * collector, and what lets `RIVET_TELEMETRY=off` be a different object rather
 * than a different code path.
 *
 * It takes a `Tracer` and a `Meter` rather than a provider, so the object is
 * trivially constructible in a test against an in-memory exporter. Assembling
 * the providers, the exporters and the global context manager is
 * `startOtelTelemetry`'s job, and nothing here reads an environment variable.
 */

const SPAN_KINDS: Record<SpanKind, OtelSpanKind> = {
  internal: OtelSpanKind.INTERNAL,
  client: OtelSpanKind.CLIENT,
  server: OtelSpanKind.SERVER,
  producer: OtelSpanKind.PRODUCER,
  consumer: OtelSpanKind.CONSUMER,
};

const SPAN_STATUSES: Record<SpanStatus, SpanStatusCode> = {
  unset: SpanStatusCode.UNSET,
  ok: SpanStatusCode.OK,
  error: SpanStatusCode.ERROR,
};

/**
 * The port's attribute bag as OTel's.
 *
 * The two types agree on every scalar and disagree on one thing: the port's
 * array values are `readonly`, and OTel's are not. Copying rather than casting
 * costs an allocation on an array attribute - which is rare - and removes the
 * possibility of the SDK mutating a caller's frozen array.
 */
function toOtelAttributes(attributes: Attributes): OtelAttributes {
  const converted: OtelAttributes = {};
  for (const [key, value] of Object.entries(compactAttributes(attributes))) {
    converted[key] = toOtelAttributeValue(value);
  }
  return converted;
}

function toOtelAttributeValue(value: AttributeValue): OtelAttributeValue {
  // `Array.isArray` does not narrow a `readonly T[]` out of the union in the
  // false branch, so the scalar side is asserted too. Both assertions cover the
  // same narrowing gap; neither widens what the port accepts.
  if (!Array.isArray(value)) return value as OtelAttributeValue;
  // Copied rather than cast through, because the port's arrays are `readonly`
  // and OTel's are not - and a frozen array the SDK decides to sort in place is
  // a crash in the one code path that must never have one.
  //
  // The assertion is on the copy and covers a narrowing gap rather than a real
  // one: the port's type is `readonly string[] | readonly number[] | readonly
  // boolean[]` and OTel's is the same three arrays unmixed, but `Array.isArray`
  // widens the element type to the union, which no longer matches either side.
  return [...(value as readonly (string | number | boolean)[])] as OtelAttributeValue;
}

class OtelSpanAdapter implements Span {
  /** The SDK span, read by `startSpan` when this one is named as a parent. */
  readonly otel: OtelSpanApi;

  #ended = false;

  constructor(otel: OtelSpanApi) {
    this.otel = otel;
  }

  setAttribute(key: string, value: AttributeValue | undefined): void {
    // The port allows `undefined` as a value and says it means "never set".
    // Passing it through would let the SDK record the key with a dropped value
    // in some exporters and omit it in others.
    if (value === undefined) return;
    this.otel.setAttribute(key, toOtelAttributeValue(value));
  }

  setAttributes(attributes: Attributes): void {
    this.otel.setAttributes(toOtelAttributes(attributes));
  }

  recordException(error: unknown): void {
    // `describeError` rather than the raw value, so a thrown string, a rejected
    // object and an `Error` all arrive as the same shape - and so the message
    // on the span matches the one on the `run.failed` event describing the same
    // failure. Two different renderings of one error is how a timeline and a
    // trace start disagreeing about what happened.
    this.otel.recordException(error instanceof Error ? error : describeError(error));
  }

  setStatus(status: SpanStatus, message?: string): void {
    this.otel.setStatus({
      code: SPAN_STATUSES[status],
      ...(message === undefined ? {} : { message }),
    });
  }

  /**
   * Idempotent, which the SDK's own `end` is not.
   *
   * `runWithSpan` ends every span in a `finally`, so a caller that also ends one
   * inside the body double-ends it. OTel answers that with a diagnostic warning
   * on every occurrence; the port says the second call is simply ignored.
   */
  end(endTime?: number): void {
    if (this.#ended) return;
    this.#ended = true;
    this.otel.end(endTime);
  }

  traceContext(): string | undefined {
    const spanContext = this.otel.spanContext();
    return trace.isSpanContextValid(spanContext) ? formatTraceParent(spanContext) : undefined;
  }
}

export class OtelTelemetry implements Telemetry {
  readonly #tracer: Tracer;
  readonly #meter: Meter;
  readonly #counters = new Map<string, OtelCounter>();
  readonly #histograms = new Map<string, OtelHistogram>();
  readonly #gauges = new Map<string, OtelGauge>();

  constructor(tracer: Tracer, meter: Meter) {
    this.#tracer = tracer;
    this.#meter = meter;
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    return new OtelSpanAdapter(
      this.#tracer.startSpan(
        name,
        {
          kind: SPAN_KINDS[options.kind ?? "internal"],
          ...(options.attributes ? { attributes: toOtelAttributes(options.attributes) } : {}),
          ...(options.links ? { links: toLinks(options.links) } : {}),
          ...(options.startTime === undefined ? {} : { startTime: options.startTime }),
        },
        parentContext(options.parent),
      ),
    );
  }

  /**
   * The one method that is not a straight translation.
   *
   * `runWithSpan` owns opening the span, recording a thrown error on it and
   * ending it either way - shared with the no-op and the fake so all three
   * cannot diverge on what happens to an exception. What the SDK needs on top
   * of that is for the span to be *active* while the body runs, because that is
   * how a command span started deeper in the stack finds the phase span it
   * belongs under without being handed one. So the body is wrapped in
   * `context.with`, and nothing else about the shared helper changes.
   *
   * This is also why `startOtelTelemetry` registers an async-hooks context
   * manager: without one, `context.with` does not survive an `await` and every
   * span in an async body would come out as a root.
   */
  withSpan<T>(name: string, options: SpanOptions | undefined, body: SpanBody<T>): Promise<T> {
    return runWithSpan(this, name, options, (span) =>
      otelContext.with(trace.setSpan(otelContext.active(), (span as OtelSpanAdapter).otel), () =>
        body(span),
      ),
    );
  }

  counter(name: string, options?: InstrumentOptions): Counter {
    // Memoized because the port promises that two lookups of one name add to
    // one series. The SDK would in fact hand back an equivalent instrument each
    // time, and would log a duplicate-registration warning if the descriptions
    // ever disagreed; caching makes the promise structural instead.
    let counter = this.#counters.get(name);
    if (!counter) {
      counter = this.#meter.createCounter(name, options);
      this.#counters.set(name, counter);
    }
    const instrument = counter;
    return {
      add: (value, attributes) => instrument.add(value, toOtelAttributes(attributes ?? {})),
    };
  }

  histogram(name: string, options?: InstrumentOptions): Histogram {
    let histogram = this.#histograms.get(name);
    if (!histogram) {
      histogram = this.#meter.createHistogram(name, options);
      this.#histograms.set(name, histogram);
    }
    const instrument = histogram;
    return {
      record: (value, attributes) => instrument.record(value, toOtelAttributes(attributes ?? {})),
    };
  }

  gauge(name: string, options?: InstrumentOptions): Gauge {
    let gauge = this.#gauges.get(name);
    if (!gauge) {
      gauge = this.#meter.createGauge(name, options);
      this.#gauges.set(name, gauge);
    }
    const instrument = gauge;
    return {
      record: (value, attributes) => instrument.record(value, toOtelAttributes(attributes ?? {})),
    };
  }

  traceContext(): string | undefined {
    const active = trace.getSpanContext(otelContext.active());
    return active && trace.isSpanContextValid(active) ? formatTraceParent(active) : undefined;
  }
}

/**
 * The context a new span is parented to.
 *
 * An explicit `parent` wins; absent one, whatever `withSpan` made active. A
 * parent this adapter did not create is refused loudly, the same way
 * `RecordingTelemetry` refuses one: a span silently reparented to the ambient
 * context produces a tree that looks plausible and describes something that
 * never happened.
 */
function parentContext(parent: Span | undefined) {
  if (parent === undefined) return otelContext.active();
  if (parent instanceof OtelSpanAdapter) {
    return trace.setSpan(otelContext.active(), parent.otel);
  }
  throw new Error(
    "OtelTelemetry was given a parent span it did not create. Two telemetry implementations are wired into the same run.",
  );
}

/**
 * Links, with the unparseable ones dropped rather than thrown on.
 *
 * A link's `traceContext` is usually a string read back from
 * `jobs.trace_context`, written by some earlier process. If it is malformed -
 * an older format, a truncated column, a job created while telemetry was off -
 * the right answer is an attempt span with no link, not a failed attempt.
 * Telemetry does not get to change the outcome of a run.
 */
function toLinks(links: SpanOptions["links"]): Link[] {
  const converted: Link[] = [];
  for (const link of links ?? []) {
    const spanContext = parseTraceParent(link.traceContext);
    if (!spanContext) continue;
    converted.push({
      context: spanContext,
      ...(link.attributes ? { attributes: toOtelAttributes(link.attributes) } : {}),
    });
  }
  return converted;
}
