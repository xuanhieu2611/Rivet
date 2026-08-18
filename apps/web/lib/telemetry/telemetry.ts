import "server-only";

import { NOOP_TELEMETRY, type Telemetry } from "@rivet/core";
import {
  setTelemetryDiagnostics,
  startOtelTelemetry,
  type TelemetryHandle,
} from "@rivet/telemetry";

import { resolveWebTelemetryConfig, TELEMETRY_DISABLED_MESSAGE } from "./config";

/**
 * The web app's telemetry, built once per server process.
 *
 * The same laziness rule as `@rivet/database` and `@rivet/queue`, and for the
 * same CI reason: importing this module opens no connection and throws nothing,
 * so `next build` still runs on a machine with no collector. Everything is
 * inside a function, and the handle is memoized on `globalThis` outside
 * production because Next re-evaluates server modules on every hot reload - a
 * fresh SDK per edit would register a new global provider and leak an export
 * timer until the dev server was restarted.
 *
 * When telemetry is off - the default, and what CI runs - this hands back
 * `NOOP_TELEMETRY`, so route handlers have one shape rather than a branch.
 */

const GLOBAL_KEY = Symbol.for("rivet.web.telemetry");

interface TelemetryGlobal {
  [GLOBAL_KEY]?: TelemetryHandle | null;
}

/**
 * Starts the SDK, or decides once that there is nothing to start.
 *
 * `null` is the memoized "off" answer, distinct from `undefined`, which means
 * "not decided yet". Without that distinction a disabled deployment would
 * re-resolve its configuration on every request.
 */
function handle(): TelemetryHandle | null {
  const store = globalThis as TelemetryGlobal;
  const existing = store[GLOBAL_KEY];
  if (existing !== undefined) return existing;

  const config = resolveWebTelemetryConfig();
  if (!config.enabled) {
    // `disabled` is the default and says nothing: a control plane that prints a
    // line about the observability it was not asked for is noise. `unconfigured`
    // means somebody set `RIVET_TELEMETRY=otlp` and got the endpoint wrong,
    // which is a typo they want to hear about exactly once.
    if (config.reason === "unconfigured") {
      console.warn(`[telemetry] ${TELEMETRY_DISABLED_MESSAGE[config.reason]}`);
    }
    store[GLOBAL_KEY] = null;
    return null;
  }

  setTelemetryDiagnostics({
    warn: (message) => console.warn(`[telemetry] ${message}`),
    error: (message) => console.error(`[telemetry] ${message}`),
  });

  const started = startOtelTelemetry({
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    environment: config.environment,
    endpoint: config.endpoint,
    onExportFailure: (message) => console.warn(`[telemetry] ${message}`),
  });

  store[GLOBAL_KEY] = started;
  return started;
}

/** The port, always. `NOOP_TELEMETRY` when there is nowhere to send anything. */
export function getWebTelemetry(): Telemetry {
  return handle()?.telemetry ?? NOOP_TELEMETRY;
}

/**
 * The active span's `traceparent`, or undefined.
 *
 * Two callers: the logger's mixin, and `POST /api/jobs`, which stamps it on
 * `jobs.trace_context` so the worker can link each attempt back to the click.
 */
export function currentTraceContext(): string | undefined {
  return getWebTelemetry().traceContext();
}

/** Flushes whatever is batched. Called by nothing in the request path. */
export async function shutdownWebTelemetry(): Promise<void> {
  await handle()?.shutdown();
}
