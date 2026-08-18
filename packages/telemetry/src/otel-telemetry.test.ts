import { context as otelContext, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { NOOP_TELEMETRY } from "@rivet/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { OtelTelemetry } from "./otel-telemetry";
import { formatTraceParent, parseTraceParent } from "./trace-context";

/**
 * The adapter against a real SDK, with the network replaced by an array.
 *
 * In-memory exporters rather than mocks, because the thing worth asserting is
 * what an exporter would actually be handed - the parent id, the link, the
 * status code, the dropped `undefined` attribute - and a mock of the tracer
 * would only assert that the adapter calls the methods it calls.
 */

const spans = new InMemorySpanExporter();
const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spans)],
});
const meterReader = new PeriodicExportingMetricReader({
  exporter: metrics,
  // Long enough that nothing exports on its own; every test flushes explicitly.
  exportIntervalMillis: 600_000,
});
const meterProvider = new MeterProvider({ readers: [meterReader] });

const contextManager = new AsyncLocalStorageContextManager();

let telemetry: OtelTelemetry;

beforeAll(() => {
  // `withSpan` makes a span active with `context.with`, and without async-hooks
  // storage that does not survive an `await` - every span in an async body
  // would come out as a root. This is the registration `startOtelTelemetry`
  // performs in production, done here by hand so the test needs no exporter.
  otelContext.setGlobalContextManager(contextManager.enable());
  telemetry = new OtelTelemetry(tracerProvider.getTracer("test"), meterProvider.getMeter("test"));
});

afterEach(() => {
  spans.reset();
  metrics.reset();
});

afterAll(async () => {
  otelContext.disable();
  await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
});

function finished(): ReadableSpan[] {
  return spans.getFinishedSpans();
}

async function collected(): Promise<ResourceMetrics[]> {
  await meterProvider.forceFlush();
  return metrics.getMetrics();
}

describe("spans", () => {
  it("ends the span on the way out and leaves the status unset on success", async () => {
    await telemetry.withSpan("phase.analyzing", undefined, () => "done");

    const [span] = finished();
    expect(span?.name).toBe("phase.analyzing");
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.endTime).toBeDefined();
  });

  it("records a thrown error, marks the span, and rethrows unchanged", async () => {
    const boom = new Error("provider refused");
    await expect(
      telemetry.withSpan("model.call", undefined, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const [span] = finished();
    // `describeError`'s rendering, which is also what the `run.failed` event
    // carries for the same failure. Two spellings of one error is how a
    // timeline and a trace start disagreeing about what happened.
    expect(span?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "Error: provider refused",
    });
    expect(span?.events[0]?.name).toBe("exception");
  });

  it("nests spans opened inside a body, across an await", async () => {
    // Acceptance run A in miniature: a command span belongs to the phase that
    // ran it, and the phase does not have to hand it a parent to say so.
    await telemetry.withSpan("phase.testing", undefined, async () => {
      await Promise.resolve();
      await telemetry.withSpan("sandbox.command", undefined, () => undefined);
    });

    const [command, phase] = finished();
    expect(command?.name).toBe("sandbox.command");
    expect(command?.parentSpanContext?.spanId).toBe(phase?.spanContext().spanId);
    expect(command?.spanContext().traceId).toBe(phase?.spanContext().traceId);
    expect(phase?.parentSpanContext).toBeUndefined();
  });

  it("honours an explicit parent over the ambient one", async () => {
    const parent = telemetry.startSpan("job.run");
    await telemetry.withSpan("outer", undefined, async () => {
      await telemetry.withSpan("inner", { parent }, () => undefined);
    });
    parent.end();

    const inner = finished().find((span) => span.name === "inner");
    const root = finished().find((span) => span.name === "job.run");
    expect(inner?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
  });

  it("refuses a parent span it did not create", () => {
    // Loud, because a span silently reparented to the ambient context produces
    // a tree that looks plausible and describes something that never happened.
    expect(() =>
      telemetry.startSpan("orphan", { parent: NOOP_TELEMETRY.startSpan("elsewhere") }),
    ).toThrow(/did not create/);
  });

  it("carries kind, attributes and start time through", async () => {
    await telemetry.withSpan(
      "github.request",
      {
        kind: "client",
        attributes: { "rivet.job_id": "job-1", "http.retries": 2, "rivet.dry_run": false },
        startTime: 1_700_000_000_000,
      },
      () => undefined,
    );

    const [span] = finished();
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes).toEqual({
      "rivet.job_id": "job-1",
      "http.retries": 2,
      "rivet.dry_run": false,
    });
  });

  it("drops attributes set to undefined instead of recording the key", async () => {
    // The port allows `undefined` as a value so a caller can write
    // `pullRequestNumber ?? undefined` without a conditional spread, and
    // promises the key is then never set.
    await telemetry.withSpan(
      "phase.finalizing",
      { attributes: { a: "1", b: undefined } },
      (span) => {
        span.setAttribute("c", undefined);
        span.setAttributes({ d: undefined, e: 4 });
      },
    );

    expect(finished()[0]?.attributes).toEqual({ a: "1", e: 4 });
  });

  it("links an attempt to the request that created it, in another trace", async () => {
    const request = telemetry.startSpan("http.post /api/jobs");
    const stored = request.traceContext();
    request.end();
    expect(stored).toBeDefined();

    await telemetry.withSpan(
      "job.run",
      { links: [{ traceContext: stored ?? "", attributes: { "rivet.link": "creating_request" } }] },
      () => undefined,
    );

    const run = finished().find((span) => span.name === "job.run");
    expect(run?.links).toHaveLength(1);
    expect(
      formatTraceParent(run?.links[0]?.context ?? { traceId: "", spanId: "", traceFlags: 0 }),
    ).toBe(stored);
    // Siblings related by link, deliberately not one trace spanning both.
    expect(run?.spanContext().traceId).not.toBe(parseTraceParent(stored ?? "")?.traceId);
  });

  it("drops an unparseable link rather than failing the span", async () => {
    await telemetry.withSpan(
      "job.run",
      { links: [{ traceContext: "not-a-traceparent" }] },
      () => undefined,
    );
    expect(finished()[0]?.links).toEqual([]);
  });

  it("ignores a second end, which runWithSpan's finally makes routine", async () => {
    await telemetry.withSpan("phase.planning", undefined, (span) => {
      span.end();
    });
    expect(finished()).toHaveLength(1);
  });
});

describe("traceContext", () => {
  it("reports the active span while a body runs, and nothing outside one", async () => {
    expect(telemetry.traceContext()).toBeUndefined();

    let inside: string | undefined;
    await telemetry.withSpan("phase.implementing", undefined, (span) => {
      inside = telemetry.traceContext();
      expect(inside).toBe(span.traceContext());
    });

    expect(parseTraceParent(inside ?? "")).toBeDefined();
    expect(telemetry.traceContext()).toBeUndefined();
  });
});

describe("instruments", () => {
  it("records counters, histograms and gauges with their attributes", async () => {
    telemetry.counter("rivet.jobs.completed", { unit: "1" }).add(1, { status: "completed" });
    telemetry.histogram("rivet.job.duration", { unit: "ms" }).record(1_500, { phase: "testing" });
    telemetry.gauge("rivet.jobs.active").record(3);

    const scope = (await collected())[0]?.scopeMetrics[0];
    const byName = new Map(scope?.metrics.map((metric) => [metric.descriptor.name, metric]));

    const completed = byName.get("rivet.jobs.completed");
    expect(completed?.dataPointType).toBe(DataPointType.SUM);
    expect(completed?.dataPoints[0]?.value).toBe(1);
    expect(completed?.dataPoints[0]?.attributes).toEqual({ status: "completed" });

    const duration = byName.get("rivet.job.duration");
    expect(duration?.dataPointType).toBe(DataPointType.HISTOGRAM);
    expect(byName.get("rivet.jobs.active")?.dataPoints[0]?.value).toBe(3);
  });

  it("adds to one series when a name is looked up twice", async () => {
    // The port's promise, which is what lets a caller ask for its instrument at
    // the point of use instead of holding one in module scope.
    telemetry.counter("rivet.model.calls").add(1);
    telemetry.counter("rivet.model.calls").add(2);

    const metric = (await collected())[0]?.scopeMetrics[0]?.metrics.find(
      (candidate) => candidate.descriptor.name === "rivet.model.calls",
    );
    expect(metric?.dataPoints).toHaveLength(1);
    expect(metric?.dataPoints[0]?.value).toBe(3);
  });
});
