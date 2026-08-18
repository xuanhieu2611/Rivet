import {
  setTelemetryDiagnostics,
  startOtelTelemetry,
  type TelemetryHandle,
} from "@rivet/telemetry";
import type { Logger } from "pino";

import type { TelemetryConfig } from "./config";

/**
 * The worker's half of `RIVET_TELEMETRY`.
 *
 * The same shape as `createGitHubOptions` and `createLocalSeedOptions`: one
 * function, called once from `index.ts`, that turns a validated configuration
 * into an optional capability - so `@rivet/core` never learns that
 * OpenTelemetry exists and nothing downstream has to ask which mode the worker
 * is in. Under `off` it returns `undefined`, `PipelineOptions.telemetry` is
 * absent, and every use site falls back to `NOOP_TELEMETRY`.
 *
 * Unlike its four siblings, `off` is not refused in production. A worker with
 * telemetry off is degraded, not dishonest: it still does every piece of work
 * it claims to. `index.ts` warns instead, and the warning is the whole
 * enforcement.
 */
export function createWorkerTelemetry(
  config: TelemetryConfig,
  workerId: string,
  log: Logger,
): TelemetryHandle | undefined {
  if (config.mode === "off") return undefined;

  // The SDK's own diagnostics, which are otherwise written nowhere. Without
  // this, a collector that has been refusing connections since Tuesday looks
  // exactly like one that is working.
  setTelemetryDiagnostics({
    warn: (message) => log.warn({ component: "otel" }, message),
    error: (message) => log.error({ component: "otel" }, message),
  });

  return startOtelTelemetry({
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    environment: config.environment,
    workerId,
    endpoint: config.endpoint,
    exportIntervalMs: config.exportIntervalMs,
    exportTimeoutMs: config.exportTimeoutMs,
    // Rate-limited by pino's own level rather than here: an export failure is
    // reported once per batch, and a collector that is down for an hour is a
    // handful of lines a minute, not a flood.
    onExportFailure: (message) => log.warn({ component: "otel" }, message),
  });
}
