import "server-only";

import { traceFields } from "@rivet/core";
import { pino, type Logger } from "pino";

import { currentTraceContext } from "./telemetry/telemetry";

export type { Logger };

/**
 * Structured logs for the control plane, which until Milestone 11 had none.
 *
 * The worker has had pino since Milestone 1; the web app had `console.error` in
 * one helper and nothing anywhere else, so there was no way at all to relate a
 * click to the worker line it caused. That gap is most of the "structured
 * logging" checklist item, and closing it is what makes the trace and the log
 * two views of one event rather than two systems that happen to run at once.
 *
 * Every line carries `trace_id` and `span_id` from whatever span is active,
 * through the same `traceFields` helper the worker's logger uses - one parser,
 * so the two deployables cannot disagree about what a correlated line looks
 * like. When telemetry is off the pair is simply absent.
 *
 * No `pino-pretty` transport here, deliberately. The transport runs in a worker
 * thread loaded by path, which is exactly the thing a bundler cannot follow;
 * the worker can afford it because it is executed by `tsx` from source, and the
 * web app cannot. Development output is therefore JSON, which `next dev` prints
 * verbatim.
 */

const GLOBAL_KEY = Symbol.for("rivet.web.logger");

interface LoggerGlobal {
  [GLOBAL_KEY]?: Logger;
}

/**
 * One logger per server process, memoized for the reason every other lazy
 * singleton here is: Next re-evaluates server modules on hot reload, and a
 * fresh pino instance per edit is a slow leak nobody notices until the dev
 * server is minutes old.
 */
export function getLogger(): Logger {
  const store = globalThis as LoggerGlobal;
  store[GLOBAL_KEY] ??= pino({
    level: resolveLevel(),
    base: { service: "rivet-web" },
    mixin: () => traceFields(currentTraceContext()) ?? {},
  });
  return store[GLOBAL_KEY];
}

/**
 * The level, and the one environment that is deliberately silent.
 *
 * Under vitest these lines are noise rather than the deliverable: unit tests
 * call route handlers directly, so every case would print a completed-request
 * line into the reporter's output. A set-but-blank variable is treated as
 * unset, the same rule `parseWorkerConfig` and `resolveWebTelemetryConfig`
 * follow, because `.env` files are full of blank placeholders. `LOG_LEVEL`
 * rather than a `RIVET_` variable of its own, so one setting moves both
 * deployables - a deployment where only half the system got quieter is a
 * deployment nobody can reason about.
 */
function resolveLevel(): string {
  const configured = process.env.LOG_LEVEL?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return process.env.NODE_ENV === "test" ? "silent" : "info";
}

/**
 * The per-request child every route handler logs through.
 *
 * `requestId` rather than a trace id alone, because a request whose telemetry
 * is off still needs to be one thing in a log file - and because the same id
 * goes on the span as `rivet.request_id`, so a line found by grep leads to a
 * trace and back again.
 */
export function requestLogger(details: {
  requestId: string;
  route: string;
  method: string;
}): Logger {
  return getLogger().child(details);
}
