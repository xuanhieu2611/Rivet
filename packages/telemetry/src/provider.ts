import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context as otelContext, diag, DiagLogLevel, propagation, trace } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Telemetry } from "@rivet/core";

import { OtelTelemetry } from "./otel-telemetry";
import {
  type ExportFailureSink,
  FetchOtlpMetricExporter,
  FetchOtlpTraceExporter,
} from "./otlp-exporter";
import { resourceAttributes, type ResourceOptions } from "./resource";

/**
 * The SDK, assembled - and the one function in this package that touches
 * anything global.
 *
 * **Importing this package must never open a connection and must never throw**,
 * the same rule as `@rivet/database`, `@rivet/queue` and `@rivet/sandbox`, and
 * for the same reason: `pnpm build` and `pnpm test` run in CI with no
 * collector, no `OTEL_EXPORTER_OTLP_ENDPOINT` and no network. Every export here
 * is a function or a type, and nothing is constructed at module scope.
 *
 * Constructing the exporters connects to nothing either. The transport dials
 * per export, so a worker started with a collector that is down still starts,
 * still runs jobs and still reports - it drops spans and says so through the
 * failure sink. Telemetry is not allowed to be a reason a job fails, which is
 * what acceptance run C asserts and why the exporters here are Rivet's own
 * (see `otlp-exporter.ts` for the crash that made that necessary).
 */

export interface TelemetryOptions extends ResourceOptions {
  /**
   * The collector's **base** URL - `http://localhost:4318`, not a signal path.
   *
   * The signal paths are appended here rather than being configured, because
   * the two exporters must agree about which collector they are talking to and
   * a pair of separately configured URLs is a configuration that can be half
   * wrong. The SDK would otherwise read `OTEL_EXPORTER_OTLP_ENDPOINT` from the
   * environment itself; it is passed explicitly instead, so that the value the
   * worker validated at startup is the value the exporter uses.
   */
  endpoint: string;
  /** Extra OTLP headers, for a collector that wants an auth header. */
  headers?: Record<string, string>;
  /** How often metrics are pushed. Traces batch on the SDK's own schedule. */
  exportIntervalMs?: number;
  /** Per-request budget for one OTLP POST. */
  exportTimeoutMs?: number;
  /**
   * Where a failed export is reported.
   *
   * Absent, a collector that is down is silent - which is the one failure mode
   * an observability stack must not have, because it looks exactly like a
   * system that is quiet. The worker passes its logger.
   */
  onExportFailure?: ExportFailureSink;
  /**
   * Whether to make this the process-wide OTel provider.
   *
   * On by default, because the point of registering is that a library which
   * instruments itself - `undici`, Next.js - lands in the same traces Rivet
   * opens. Tests pass `false` so that two of them cannot fight over the global.
   */
  register?: boolean;
}

/**
 * A running SDK: the port, and the way to stop it.
 *
 * `shutdown` flushes both pipelines. A worker that exits without calling it
 * loses whatever is still batched, which for a short-lived process - the
 * evaluation runner, a demo script - is most of the run.
 */
export interface TelemetryHandle {
  telemetry: Telemetry;
  /** Flushes and stops both pipelines. Safe to call twice. */
  shutdown(): Promise<void>;
}

/** Instrumentation scope, so a span's origin is visible in a backend. */
const SCOPE_NAME = "@rivet/telemetry";

/** Appends a signal path to a base OTLP endpoint, tolerating a trailing slash. */
export function signalUrl(endpoint: string, signal: "traces" | "metrics"): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/${signal}`;
}

export function startOtelTelemetry(options: TelemetryOptions): TelemetryHandle {
  const resource = resourceFromAttributes(resourceAttributes(options));
  const exporter = (signal: "traces" | "metrics") => ({
    url: signalUrl(options.endpoint, signal),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.exportTimeoutMs === undefined ? {} : { timeoutMs: options.exportTimeoutMs }),
    ...(options.onExportFailure ? { onFailure: options.onExportFailure } : {}),
  });

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new FetchOtlpTraceExporter(exporter("traces")))],
  });

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new FetchOtlpMetricExporter(exporter("metrics")),
        ...(options.exportIntervalMs === undefined
          ? {}
          : { exportIntervalMillis: options.exportIntervalMs }),
      }),
    ],
  });

  if (options.register !== false) {
    // The context manager is the load-bearing registration, not the provider.
    // `OtelTelemetry.withSpan` uses `context.with` to make a span active for
    // its body, and without async-hooks storage that context does not survive
    // an `await` - every span in an async phase would come out as a root, and
    // acceptance run A's whole assertion is about nesting.
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(tracerProvider);
  }

  const telemetry = new OtelTelemetry(
    tracerProvider.getTracer(SCOPE_NAME),
    meterProvider.getMeter(SCOPE_NAME),
  );

  let stopped: Promise<void> | undefined;
  return {
    telemetry,
    shutdown: () => {
      // Memoized rather than guarded by a boolean, so a second caller waits for
      // the first flush instead of returning while spans are still in flight.
      //
      // And it never rejects. The SDK's shutdown rejects when the final flush
      // cannot reach the collector, which would make a worker's graceful
      // shutdown fail - stopping the queue drain and the connection close that
      // follow it - because an observability backend was down. The failure is
      // already reported through `onExportFailure`; here it is swallowed.
      stopped ??= Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]).then(
        () => undefined,
      );
      return stopped;
    },
  };
}

/**
 * Sends the SDK's own diagnostics somewhere, instead of nowhere.
 *
 * OTel swallows exporter failures by design - an observability library that
 * throws into its host is worse than one that loses data - which means a
 * collector that has been refusing connections for an hour looks exactly like
 * one that is working. This is how a deployment gets told, and it is opt-in
 * with an explicit sink so that `packages/telemetry` needs no opinion about
 * what a logger is.
 */
export function setTelemetryDiagnostics(
  sink: { warn(message: string): void; error(message: string): void },
  level: DiagLogLevel = DiagLogLevel.ERROR,
): void {
  diag.setLogger(
    {
      verbose: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (message, ...args) => sink.warn([message, ...args.map(String)].join(" ")),
      error: (message, ...args) => sink.error([message, ...args.map(String)].join(" ")),
    },
    level,
  );
}

export { DiagLogLevel };
