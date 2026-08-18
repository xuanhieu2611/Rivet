import "server-only";

import { randomUUID } from "node:crypto";

import { ATTR_REQUEST_ID, ATTR_ROUTE } from "@rivet/core";
import type { Logger } from "pino";

import { requestLogger } from "../logger";
import { getWebTelemetry } from "../telemetry/telemetry";

/**
 * One span and one child logger per request, applied at every route handler.
 *
 * Wrapping each handler explicitly rather than instrumenting the framework, and
 * that is a decision rather than a shortcut. Auto-instrumentation would need an
 * HTTP instrumentation package hooking Node's `http` module, which would trace
 * Next's own asset and RSC traffic as enthusiastically as Rivet's API - and the
 * request span is not the valuable part anyway. What is valuable is that this
 * span is *active* for the body, so `jobs.trace_context` gets a real
 * `traceparent` and every log line in the handler carries the same trace id.
 *
 * The span name is the route **pattern**, never the resolved path. A span named
 * `GET /api/jobs/6f1c9c3e-...` makes a backend's operation list unbounded and
 * every aggregation useless; the job id goes on `rivet.job_id`, where it can be
 * filtered on.
 *
 * `withRoute` never changes what a handler returns and never converts a throw
 * into a response. Telemetry does not get to change the outcome of a request,
 * the same rule acceptance run C states for a run.
 */
export function withRoute<A extends unknown[]>(
  route: string,
  handler: (request: Request, context: RouteTelemetry, ...args: A) => Promise<Response>,
): (request: Request, ...args: A) => Promise<Response> {
  return (request, ...args) => {
    // The client's id is deliberately not trusted as the correlation id itself.
    // It is recorded as an attribute below so a caller can still find its own
    // request, but the id this process logs and spans under is its own.
    const requestId = randomUUID();
    const method = request.method;
    const name = `${method} ${route}`;

    return getWebTelemetry().withSpan(
      name,
      {
        kind: "server",
        attributes: {
          [ATTR_ROUTE]: route,
          [ATTR_REQUEST_ID]: requestId,
          "http.request.method": method,
        },
      },
      async (span) => {
        const log = requestLogger({ requestId, route, method });
        const startedAt = Date.now();
        try {
          const response = await handler(request, { requestId, log, route }, ...args);
          span.setAttribute("http.response.status_code", response.status);
          log.info(
            { status: response.status, durationMs: Date.now() - startedAt },
            "request completed",
          );
          return response;
        } catch (error) {
          // Logged here as well as recorded on the span, because a handler that
          // throws past its own `try` returns Next's generic 500 and this is
          // the only place the cause is written down.
          log.error({ err: error, durationMs: Date.now() - startedAt }, "request failed");
          throw error;
        }
      },
    );
  };
}

/** What a wrapped handler is handed alongside the request. */
export interface RouteTelemetry {
  /** Also on the span as `rivet.request_id`, and on every line `log` writes. */
  requestId: string;
  /** A child logger already carrying the request id, route and method. */
  log: Logger;
  /** The route pattern, for a handler that wants to name itself in an error. */
  route: string;
}
