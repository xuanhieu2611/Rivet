/**
 * The telemetry PORT: what the domain needs from an observability backend, and
 * nothing more.
 *
 * Types, an interface and one shared helper - no SDK, for the same reason
 * `queue/job-queue.ts` holds no BullMQ and `sandbox/sandbox.ts` holds no
 * dockerode. `@opentelemetry/api` is a facade that no-ops until a provider is
 * registered, so importing it here would not break a test; it would break the
 * rule that makes the tests worth trusting. Core is shared by two deployables
 * and must not depend on either one's delivery mechanism, and a port makes "did
 * this phase open a span with these attributes" an ordinary unit assertion
 * against `RecordingTelemetry` rather than something that needs an exporter and
 * a collector.
 *
 * `packages/telemetry` is the only package that will know OpenTelemetry exists.
 * Two implementations live here instead: `NOOP_TELEMETRY`, which is what a
 * worker with `RIVET_TELEMETRY=off` runs, and `RecordingTelemetry`, which is
 * what the tests run. Core cannot depend on the adapter package without
 * inverting the port, which is why the fake is here and not there.
 */

import { describeError } from "../jobs/failure";

/**
 * A single attribute value, mirroring what OTLP can actually carry.
 *
 * Deliberately not `unknown`. An attribute the exporter has to guess at is an
 * attribute that arrives in one backend and vanishes in another, and the
 * failure is invisible until someone builds a dashboard on it.
 */
export type AttributeValue =
  string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

/**
 * An attribute bag.
 *
 * `undefined` is an allowed *value* so that a caller can write
 * `{ "rivet.pull_request_number": job.pullRequestNumber ?? undefined }` rather
 * than building the object conditionally. Implementations drop those keys; they
 * never reach an exporter. This is the one place the port is more permissive
 * than OTLP, and it is on purpose: the alternative is conditional spreads at
 * every call site, which is where attributes quietly stop being recorded.
 */
export type Attributes = Readonly<Record<string, AttributeValue | undefined>>;

/**
 * Where a span sits relative to the work it describes.
 *
 * The OTel vocabulary, unchanged, because renaming it would only mean
 * translating it back in the adapter.
 */
export type SpanKind = "internal" | "client" | "server" | "producer" | "consumer";

/** A span's outcome. `unset` is the default and means "nothing was claimed". */
export type SpanStatus = "unset" | "ok" | "error";

/**
 * A relationship to a span in another trace.
 *
 * Carried as a W3C `traceparent` string rather than as a `Span`, because the
 * span being linked to is generally over and in another process. That is the
 * whole reason M11 stores one on `jobs.trace_context`: each attempt of a job
 * gets its own root span linked back to the request that created it, so three
 * attempts are three sibling traces rather than one twenty-minute root span
 * spanning three processes that most backends would drop.
 */
export interface SpanLink {
  /** A W3C `traceparent`, as produced by `Span.traceContext()`. */
  traceContext: string;
  attributes?: Attributes;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  links?: readonly SpanLink[];
  /**
   * The parent span, stated rather than inferred.
   *
   * Core threads its dependencies explicitly and has no ambient context to read
   * from, so a phase that wants its command spans underneath it says so. Absent
   * it, an implementation may fall back to whatever it considers active -
   * `withSpan` establishes exactly that for the duration of its body, which is
   * what makes ordinary nesting free.
   */
  parent?: Span;
  /** Epoch milliseconds. Absent, the implementation reads its own clock. */
  startTime?: number;
}

export interface Span {
  setAttribute(key: string, value: AttributeValue | undefined): void;
  setAttributes(attributes: Attributes): void;
  /**
   * Attaches an error to the span without deciding the span's outcome.
   *
   * Separate from `setStatus` because the two are genuinely separate facts: a
   * retried operation records an exception and still succeeds.
   */
  recordException(error: unknown): void;
  setStatus(status: SpanStatus, message?: string): void;
  /** Idempotent. A second call is ignored rather than being an error. */
  end(endTime?: number): void;
  /**
   * This span's own W3C `traceparent`, or `undefined` when nothing is
   * recording it.
   *
   * The string form rather than an id pair, because the only two things Rivet
   * does with it are store it in `jobs.trace_context` and hand it back as a
   * `SpanLink`, and both of those are text.
   */
  traceContext(): string | undefined;
}

/** Options shared by every instrument. All optional; all descriptive. */
export interface InstrumentOptions {
  /** UCUM, e.g. `ms`, `By`, `1`, `{token}`. */
  unit?: string;
  description?: string;
}

/** Monotonic. `add` takes a delta, never a total. */
export interface Counter {
  add(value: number, attributes?: Attributes): void;
}

/** A distribution. `record` takes one observation. */
export interface Histogram {
  record(value: number, attributes?: Attributes): void;
}

/** A last-value instrument. `record` takes the current value, not a delta. */
export interface Gauge {
  record(value: number, attributes?: Attributes): void;
}

/** The body `withSpan` runs. Sync or async; both are awaited the same way. */
export type SpanBody<T> = (span: Span) => T | PromiseLike<T>;

export interface Telemetry {
  /**
   * Opens a span the caller is responsible for ending.
   *
   * Prefer `withSpan`. This exists for the spans whose lifetime is not a
   * lexical block - a `job.run` root that outlives the function opening it, for
   * one - and every use of it owes a `finally`.
   */
  startSpan(name: string, options?: SpanOptions): Span;

  /**
   * Runs `body` inside a span, ending it on the way out either way.
   *
   * An error propagates unchanged after being recorded on the span and marking
   * it `error`; success leaves the status `unset`, which is the OTel
   * convention - `ok` means "an instrumentation author asserted this", not
   * "it did not throw".
   *
   * Spans opened inside the body without an explicit `parent` nest underneath
   * this one. That is the property acceptance run A checks: command and model
   * spans belong to the phase that ran them.
   */
  withSpan<T>(name: string, options: SpanOptions | undefined, body: SpanBody<T>): Promise<T>;

  /**
   * Instruments are looked up by name, not constructed.
   *
   * Calling `counter("rivet.jobs.completed")` twice returns something that adds
   * to one series. Callers therefore do not have to hold instruments in module
   * scope, which is what would otherwise force a global provider on a package
   * that takes its dependencies as arguments.
   */
  counter(name: string, options?: InstrumentOptions): Counter;
  histogram(name: string, options?: InstrumentOptions): Histogram;
  gauge(name: string, options?: InstrumentOptions): Gauge;

  /**
   * The currently active span's W3C `traceparent`, or `undefined`.
   *
   * "Active" means the innermost enclosing `withSpan` body, or whatever the
   * implementation's own context propagation says when there is none. Used by
   * the creating request to stamp `jobs.trace_context` and by pino's mixin to
   * put trace and span ids on every log line - both of which are places that
   * have a telemetry handle but no span in hand.
   */
  traceContext(): string | undefined;
}

/**
 * The shared body of every `withSpan`.
 *
 * A free function rather than a base class, so `NOOP_TELEMETRY`,
 * `RecordingTelemetry` and the OTel adapter all get the same end-on-throw
 * semantics from one place. Three implementations of a `try/finally` are three
 * chances for one of them to swallow an error or leak a span.
 */
export async function runWithSpan<T>(
  telemetry: Telemetry,
  name: string,
  options: SpanOptions | undefined,
  body: SpanBody<T>,
): Promise<T> {
  const span = telemetry.startSpan(name, options);
  try {
    return await body(span);
  } catch (error) {
    span.recordException(error);
    span.setStatus("error", describeError(error));
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Drops `undefined` values, which the port allows and OTLP does not.
 *
 * Shared by both implementations here so that "an attribute set to `undefined`
 * was never set" is one rule rather than a convention each of them re-derives.
 */
export function compactAttributes(attributes: Attributes): Record<string, AttributeValue> {
  const compacted: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) compacted[key] = value;
  }
  return compacted;
}
