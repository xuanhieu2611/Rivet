import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { JsonMetricsSerializer, JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";

/**
 * OTLP/HTTP+JSON over `fetch`, written here rather than taken from
 * `@opentelemetry/exporter-trace-otlp-http`.
 *
 * **This is a deliberate replacement of a stock component, and the reason is
 * worth the paragraph.** The official Node exporters send through
 * `http.request` with a keep-alive agent and a piped body, and on Node 24 an
 * *unreachable* collector - the ordinary case, since `RIVET_TELEMETRY=otlp`
 * defaults to `http://localhost:4318` and nobody has to be running one - ends
 * the retry sequence with an `ECONNREFUSED` that escapes as an uncaught
 * exception and terminates the process. It reproduces with the stock SDK alone,
 * on more than one exporter version, in about ten lines. A worker that dies
 * because its observability backend is down is a strictly worse system than one
 * with no observability, and Rivet's standing rule is that telemetry may never
 * change the outcome of a run - acceptance run C exists to assert exactly that.
 *
 * So the transport is ours: one `fetch` POST per batch, every failure caught and
 * reported to a sink, no agent, no streams, no retries. What that costs is the
 * retry, the gzip and the protobuf encoding; what it buys is that the worst a
 * broken collector can do is drop spans and log a line. A dropped span is the
 * correct failure mode for telemetry, and the batch processor above this is
 * already the thing that decides what a batch is.
 *
 * Serialization is still OTel's own (`@opentelemetry/otlp-transformer`, the
 * same serializer the official JSON exporters use), so what goes on the wire is
 * ordinary OTLP that any collector accepts.
 */

/** Where an export failure is reported. The worker passes its pino logger. */
export type ExportFailureSink = (message: string) => void;

export interface OtlpExporterOptions {
  /** The full signal URL, e.g. `http://localhost:4318/v1/traces`. */
  url: string;
  headers?: Record<string, string>;
  /** Per-request budget. Short by design: a slow collector must not hold a shutdown. */
  timeoutMs?: number;
  onFailure?: ExportFailureSink;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The shared half of both exporters.
 *
 * Tracks in-flight requests so `forceFlush` and `shutdown` can wait for them -
 * which is the whole reason a short-lived process (the evaluation runner, a
 * demo script) sees its last batch at all - and refuses new work after
 * shutdown rather than starting a request nobody will wait for.
 */
abstract class FetchOtlpExporter {
  readonly #options: OtlpExporterOptions;
  readonly #inFlight = new Set<Promise<void>>();

  #shutdown = false;

  constructor(options: OtlpExporterOptions) {
    this.#options = options;
  }

  protected send(
    body: Uint8Array | undefined,
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (body === undefined || body.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    if (this.#shutdown) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error("telemetry exporter is shut down"),
      });
      return;
    }

    const request = this.#post(body).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: unknown) => {
        // Reported, never rethrown, and never surfaced to the caller as an
        // exception: the callers are the SDK's batch processor and metric
        // reader, and neither of them has anything useful to do about a
        // collector being down.
        this.#options.onFailure?.(
          `OTLP export to ${this.#options.url} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        resultCallback({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      },
    );

    this.#inFlight.add(request);
    void request.finally(() => this.#inFlight.delete(request));
  }

  async #post(body: Uint8Array): Promise<void> {
    const response = await fetch(this.#options.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.#options.headers },
      // A fresh copy, because the caller's view may be over a pooled buffer.
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Drained so the connection can be reused rather than left half-read.
      await response.text().catch(() => "");
      throw new Error(`collector answered ${String(response.status)}`);
    }
  }

  async forceFlush(): Promise<void> {
    // Settled rather than all: a failed export is already reported, and a
    // rejection here would turn a shutdown into a failed shutdown.
    await Promise.allSettled([...this.#inFlight]);
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    await this.forceFlush();
  }
}

export class FetchOtlpTraceExporter extends FetchOtlpExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.send(JsonTraceSerializer.serializeRequest(spans), resultCallback);
  }
}

export class FetchOtlpMetricExporter extends FetchOtlpExporter implements PushMetricExporter {
  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    this.send(JsonMetricsSerializer.serializeRequest(metrics), resultCallback);
  }

  /**
   * Cumulative, which is what Prometheus wants.
   *
   * Stage 5's local stack scrapes the collector with Prometheus, and a delta
   * counter arriving there is a counter that resets on every export interval -
   * the metric looks like a sawtooth and every `rate()` over it is wrong.
   */
  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }
}
