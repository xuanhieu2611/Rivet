import {
  type AttributeValue,
  type Attributes,
  compactAttributes,
  type Counter,
  type Gauge,
  type Histogram,
  type InstrumentOptions,
  runWithSpan,
  type Span,
  type SpanBody,
  type SpanKind,
  type SpanLink,
  type SpanOptions,
  type SpanStatus,
  type Telemetry,
} from "./telemetry";

import { describeError } from "../jobs/failure";

/** Which instrument produced a recorded measurement. */
export type InstrumentKind = "counter" | "histogram" | "gauge";

export interface RecordedMeasurement {
  kind: InstrumentKind;
  name: string;
  /** A delta for a counter, one observation for a histogram, a level for a gauge. */
  value: number;
  attributes: Record<string, AttributeValue>;
}

export interface RecordedException {
  error: unknown;
  message: string;
}

/**
 * One span, kept in memory with everything that was said about it.
 *
 * A class with public fields rather than a plain object, because assertions
 * want the tree (`parent`, `children`) as much as they want the attributes, and
 * a tree of plain objects would either be built twice or be circular in a way
 * that breaks every `toEqual`.
 */
export class RecordedSpan implements Span {
  readonly name: string;
  readonly kind: SpanKind;
  readonly links: readonly SpanLink[];
  readonly traceId: string;
  readonly spanId: string;
  readonly parent: RecordedSpan | undefined;
  readonly children: RecordedSpan[] = [];
  readonly startTime: number;
  readonly attributes: Record<string, AttributeValue> = {};
  readonly exceptions: RecordedException[] = [];

  readonly #onEnd: (span: RecordedSpan) => void;

  status: SpanStatus = "unset";
  statusMessage: string | undefined = undefined;
  endTime: number | undefined = undefined;
  ended = false;

  constructor(init: {
    name: string;
    kind: SpanKind;
    links: readonly SpanLink[];
    traceId: string;
    spanId: string;
    parent: RecordedSpan | undefined;
    startTime: number;
    attributes: Attributes | undefined;
    onEnd: (span: RecordedSpan) => void;
  }) {
    this.name = init.name;
    this.kind = init.kind;
    this.links = init.links;
    this.traceId = init.traceId;
    this.spanId = init.spanId;
    this.parent = init.parent;
    this.startTime = init.startTime;
    this.#onEnd = init.onEnd;
    if (init.attributes) this.setAttributes(init.attributes);
    init.parent?.children.push(this);
  }

  setAttribute(key: string, value: AttributeValue | undefined): void {
    // Matches the port: an attribute set to `undefined` was never set. Without
    // this, a fake would happily record a key the real exporter drops, and a
    // test would prove something no backend will ever show.
    if (value === undefined) return;
    this.attributes[key] = value;
  }

  setAttributes(attributes: Attributes): void {
    Object.assign(this.attributes, compactAttributes(attributes));
  }

  recordException(error: unknown): void {
    this.exceptions.push({ error, message: describeError(error) });
  }

  setStatus(status: SpanStatus, message?: string): void {
    this.status = status;
    this.statusMessage = message;
  }

  /**
   * Idempotent, as the port requires.
   *
   * `runWithSpan` ends the span in a `finally`, so a caller that also ends it
   * inside the body double-ends it. Recording the second end would make the
   * duration a lie; throwing would turn a harmless belt-and-braces `end()` into
   * a failed job.
   */
  end(endTime?: number): void {
    if (this.ended) return;
    this.ended = true;
    this.endTime = endTime;
    this.#onEnd(this);
  }

  traceContext(): string {
    return `00-${this.traceId}-${this.spanId}-01`;
  }

  /** How long the span was open, or `undefined` while it still is. */
  get durationMs(): number | undefined {
    return this.endTime === undefined ? undefined : this.endTime - this.startTime;
  }
}

export interface RecordingTelemetryOptions {
  /**
   * Injectable clock, defaulting to a counter rather than to `Date.now`.
   *
   * A monotonically increasing integer makes durations exact and assertions
   * about them stable, which a wall clock in CI is not. Tests that care about
   * real time pass `Date.now` themselves.
   */
  now?: () => number;
}

/**
 * The in-memory `Telemetry` the tests run against.
 *
 * It lives in `@rivet/core` rather than in `packages/telemetry` for the reason
 * the port file gives: core cannot depend on its own adapter without inverting
 * the dependency the port exists to create. That is the one place this differs
 * from `FakeSandbox` and `MemoryJobQueue`, and it is a consequence of core
 * being the package with the most to assert about spans.
 *
 * Ids are deterministic - `trace0000...0001`, `span000000000001` - because a
 * fake that generates randomness makes every snapshot useless and every failure
 * a fresh string.
 */
export class RecordingTelemetry implements Telemetry {
  /** Every span, in the order it was started. Ended or not. */
  readonly spans: RecordedSpan[] = [];
  /** Every counter, histogram and gauge observation, in order. */
  readonly measurements: RecordedMeasurement[] = [];

  readonly #now: () => number;
  readonly #stack: RecordedSpan[] = [];
  readonly #instruments = new Map<string, Counter & Histogram & Gauge>();
  #tick = 0;
  #ids = 0;

  constructor(options: RecordingTelemetryOptions = {}) {
    this.#now = options.now ?? (() => ++this.#tick);
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    const parent = resolveParent(options.parent) ?? this.#stack.at(-1);
    const id = ++this.#ids;
    const span = new RecordedSpan({
      name,
      kind: options.kind ?? "internal",
      links: options.links ?? [],
      // A child shares its parent's trace; a root opens a new one. That is the
      // structure acceptance run A reads, and it is why an attempt's `job.run`
      // takes a *link* to the creating request rather than a parent: the two
      // are deliberately different traces.
      traceId: parent ? parent.traceId : hexId(id, 32),
      spanId: hexId(id, 16),
      parent,
      startTime: options.startTime ?? this.#now(),
      attributes: options.attributes,
      onEnd: (ended) => {
        // Removed by identity rather than popped, so a caller that ends spans
        // out of order corrupts nothing. Nesting in a well-behaved run is
        // unaffected, and a misbehaving one is still readable afterwards.
        const at = this.#stack.lastIndexOf(ended);
        if (at !== -1) this.#stack.splice(at, 1);
      },
    });
    this.spans.push(span);
    // Active from start to end, which is what makes `runWithSpan` produce
    // nesting without the port needing an ambient-context concept.
    this.#stack.push(span);
    return span;
  }

  withSpan<T>(name: string, options: SpanOptions | undefined, body: SpanBody<T>): Promise<T> {
    return runWithSpan(this, name, options, body);
  }

  counter(name: string, _options?: InstrumentOptions): Counter {
    return this.#instrument("counter", name, (value, attributes) => {
      this.measurements.push({ kind: "counter", name, value, attributes });
    });
  }

  histogram(name: string, _options?: InstrumentOptions): Histogram {
    return this.#instrument("histogram", name, (value, attributes) => {
      this.measurements.push({ kind: "histogram", name, value, attributes });
    });
  }

  gauge(name: string, _options?: InstrumentOptions): Gauge {
    return this.#instrument("gauge", name, (value, attributes) => {
      this.measurements.push({ kind: "gauge", name, value, attributes });
    });
  }

  traceContext(): string | undefined {
    return this.#stack.at(-1)?.traceContext();
  }

  // --- assertions -----------------------------------------------------------

  /** Spans with no parent, in start order. One per trace. */
  rootSpans(): RecordedSpan[] {
    return this.spans.filter((span) => span.parent === undefined);
  }

  /** Every span's name, in start order. */
  spanNames(): string[] {
    return this.spans.map((span) => span.name);
  }

  spansNamed(name: string): RecordedSpan[] {
    return this.spans.filter((span) => span.name === name);
  }

  /**
   * Spans that were started and never ended.
   *
   * Worth asserting empty at the end of any run: a leaked span is the one
   * instrumentation bug that produces no error and no data.
   */
  openSpans(): RecordedSpan[] {
    return this.spans.filter((span) => !span.ended);
  }

  measurementsNamed(name: string): RecordedMeasurement[] {
    return this.measurements.filter((measurement) => measurement.name === name);
  }

  /**
   * The sum of every observation recorded under `name`.
   *
   * Meaningful for a counter and for a histogram's total; for a gauge, prefer
   * reading the last measurement, since a gauge's values are levels rather than
   * things that add up.
   */
  total(name: string): number {
    return this.measurementsNamed(name).reduce((sum, m) => sum + m.value, 0);
  }

  /** Drops everything recorded so far, keeping the id and clock sequences. */
  reset(): void {
    this.spans.length = 0;
    this.measurements.length = 0;
    this.#stack.length = 0;
  }

  #instrument(
    kind: InstrumentKind,
    name: string,
    write: (value: number, attributes: Record<string, AttributeValue>) => void,
  ): Counter & Histogram & Gauge {
    // Memoized, because the port says two lookups of one name add to one
    // series. A fake that handed back a fresh object each time would let a
    // caller hold a stale instrument and never notice.
    const key = `${kind}:${name}`;
    const existing = this.#instruments.get(key);
    if (existing) return existing;
    const created = {
      add: (value: number, attributes?: Attributes) =>
        write(value, compactAttributes(attributes ?? {})),
      record: (value: number, attributes?: Attributes) =>
        write(value, compactAttributes(attributes ?? {})),
    };
    this.#instruments.set(key, created);
    return created;
  }
}

/**
 * Refuses a parent that came from a different `Telemetry`.
 *
 * Loud rather than ignored: a span silently reparented to the recording stack
 * would produce a tree that looks right and describes something that never
 * happened, which is worse than a failing test.
 */
function resolveParent(parent: Span | undefined): RecordedSpan | undefined {
  if (parent === undefined) return undefined;
  if (parent instanceof RecordedSpan) return parent;
  throw new Error(
    "RecordingTelemetry was given a parent span it did not create. Two telemetry implementations are wired into the same run.",
  );
}

/**
 * A deterministic id of the width W3C `traceparent` requires.
 *
 * Real lowercase hex rather than a readable string, so that anything Stage 3
 * builds which actually parses a `traceparent` - a link, a log correlation
 * field - behaves the same against this fake as against the SDK.
 */
function hexId(value: number, length: number): string {
  return value.toString(16).padStart(length, "0");
}
