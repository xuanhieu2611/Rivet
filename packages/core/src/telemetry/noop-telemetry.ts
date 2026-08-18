import {
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
  type InstrumentOptions,
  runWithSpan,
  type Span,
  type SpanBody,
  type SpanOptions,
  type SpanStatus,
  type Telemetry,
} from "./telemetry";

/**
 * The `Telemetry` that does nothing, and the default everywhere.
 *
 * `PipelineOptions.telemetry` is optional and falls back to this, which is what
 * makes `RIVET_TELEMETRY=off` a configuration rather than a code path: every
 * phase calls the same methods either way, so telemetry cannot be the reason a
 * job behaves differently. Acceptance run C is the assertion that says so.
 *
 * **`off` is legal under `NODE_ENV=production`, unlike the rest of the switch
 * family.** `RIVET_SANDBOX=off`, `RIVET_AGENT=off`, `RIVET_GITHUB=off` and
 * `RIVET_EVAL=off` are refused there because a worker that skips real work
 * looks perfectly healthy - it lies. A worker with telemetry off is degraded
 * and honest about it, and refusing to boot over that is worse than the thing
 * it prevents. The worker logs a startup warning instead.
 *
 * Singletons rather than fresh objects per call: these hold no state, and
 * allocating one per span in a hot loop is a cost paid by the configuration
 * that opted out of paying for telemetry.
 */
class NoopSpan implements Span {
  setAttribute(_key: string, _value: unknown): void {
    // Nothing to record.
  }

  setAttributes(_attributes: Attributes): void {
    // Nothing to record.
  }

  recordException(_error: unknown): void {
    // Nothing to record.
  }

  setStatus(_status: SpanStatus, _message?: string): void {
    // Nothing to record.
  }

  end(_endTime?: number): void {
    // Nothing to end.
  }

  /**
   * Always `undefined`, and that is a load-bearing answer rather than a stub.
   *
   * `jobs.trace_context` is nullable precisely so that a job created while
   * telemetry was off stores no context, instead of storing an all-zero
   * `traceparent` that a later attempt would faithfully link to nothing.
   */
  traceContext(): undefined {
    return undefined;
  }
}

const NOOP_SPAN: Span = new NoopSpan();

const NOOP_COUNTER: Counter = {
  add(_value: number, _attributes?: Attributes): void {
    // Nothing to count.
  },
};

const NOOP_HISTOGRAM: Histogram = {
  record(_value: number, _attributes?: Attributes): void {
    // Nothing to record.
  },
};

const NOOP_GAUGE: Gauge = {
  record(_value: number, _attributes?: Attributes): void {
    // Nothing to record.
  },
};

class NoopTelemetry implements Telemetry {
  startSpan(_name: string, _options?: SpanOptions): Span {
    return NOOP_SPAN;
  }

  /**
   * Still goes through `runWithSpan`.
   *
   * A no-op that shortcuts to `body(NOOP_SPAN)` would be faster and would also
   * be the one implementation whose error handling was never exercised. Running
   * the shared helper means the enabled and disabled paths cannot diverge in
   * what they do to a thrown error.
   */
  withSpan<T>(name: string, options: SpanOptions | undefined, body: SpanBody<T>): Promise<T> {
    return runWithSpan(this, name, options, body);
  }

  counter(_name: string, _options?: InstrumentOptions): Counter {
    return NOOP_COUNTER;
  }

  histogram(_name: string, _options?: InstrumentOptions): Histogram {
    return NOOP_HISTOGRAM;
  }

  gauge(_name: string, _options?: InstrumentOptions): Gauge {
    return NOOP_GAUGE;
  }

  traceContext(): undefined {
    return undefined;
  }
}

/**
 * The default value of `PipelineOptions.telemetry`, and the value every caller
 * that has not been given one should reach for:
 *
 * ```ts
 * const telemetry = options.telemetry ?? NOOP_TELEMETRY;
 * ```
 *
 * Written at the use site rather than defaulted in `PipelineOptions` itself,
 * which keeps the rule that core declares no policy of its own intact.
 */
export const NOOP_TELEMETRY: Telemetry = new NoopTelemetry();
