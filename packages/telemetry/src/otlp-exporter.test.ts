import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startOtelTelemetry, type TelemetryHandle } from "./provider";

/**
 * The exporter against a real HTTP server, and against nothing at all.
 *
 * The second case is the one that matters most and is the reason
 * `otlp-exporter.ts` exists: the stock OTLP/HTTP exporters end an unreachable
 * collector's retry sequence with an uncaught `ECONNREFUSED` that terminates
 * the process, and `RIVET_TELEMETRY=otlp` points at `localhost:4318` by
 * default, where usually nothing is listening. If that ever comes back, this
 * file fails - vitest reports an uncaught exception - rather than a worker
 * dying in production because Grafana was down.
 */

interface Captured {
  path: string;
  contentType: string | undefined;
  body: unknown;
}

async function listen(captured: Captured[]): Promise<{ server: Server; endpoint: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      captured.push({
        path: request.url ?? "",
        contentType: request.headers["content-type"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, endpoint: `http://127.0.0.1:${String(port)}` };
}

let handle: TelemetryHandle | undefined;
let server: Server | undefined;

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

describe("OTLP export", () => {
  it("posts spans and metrics as OTLP JSON to the collector's signal paths", async () => {
    const captured: Captured[] = [];
    const listening = await listen(captured);
    server = listening.server;

    handle = startOtelTelemetry({
      serviceName: "rivet-worker",
      serviceVersion: "0.0.0-test",
      environment: "test",
      workerId: "worker-1",
      endpoint: listening.endpoint,
      register: false,
    });

    await handle.telemetry.withSpan(
      "phase.analyzing",
      { attributes: { "rivet.job_id": "j1" } },
      () => undefined,
    );
    handle.telemetry.counter("rivet.jobs.completed").add(1);

    // Shutdown is what flushes both pipelines; there is no interval to wait on.
    await handle.shutdown();
    handle = undefined;

    const traces = captured.find((request) => request.path === "/v1/traces");
    expect(traces?.contentType).toBe("application/json");

    const payload = traces?.body as {
      resourceSpans: [
        {
          resource: { attributes: { key: string; value: { stringValue?: string } }[] };
          scopeSpans: [{ spans: [{ name: string }] }];
        },
      ];
    };
    const resource = payload.resourceSpans[0].resource.attributes;
    expect(resource).toContainEqual({
      key: "service.name",
      value: { stringValue: "rivet-worker" },
    });
    expect(resource).toContainEqual({ key: "rivet.worker_id", value: { stringValue: "worker-1" } });
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("phase.analyzing");

    expect(captured.find((request) => request.path === "/v1/metrics")).toBeDefined();
  });

  it("survives a collector that is not there, reports it, and shuts down clean", async () => {
    const failures: string[] = [];
    handle = startOtelTelemetry({
      serviceName: "rivet-worker",
      serviceVersion: "0.0.0-test",
      environment: "test",
      // Bound to nothing. A connection here is refused immediately.
      endpoint: "http://127.0.0.1:4999",
      register: false,
      onExportFailure: (message) => failures.push(message),
    });

    await handle.telemetry.withSpan("smoke", undefined, () => undefined);
    handle.telemetry.counter("rivet.smoke").add(1);

    // Resolves rather than rejecting: a worker's graceful shutdown must not
    // fail - abandoning its queue drain and its connection close - because an
    // observability backend was down.
    await expect(handle.shutdown()).resolves.toBeUndefined();
    handle = undefined;

    expect(failures.some((message) => message.includes("/v1/traces"))).toBe(true);
    expect(failures.some((message) => message.includes("/v1/metrics"))).toBe(true);
  });
});
