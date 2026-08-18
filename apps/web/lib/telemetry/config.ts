/**
 * The web app's half of `RIVET_TELEMETRY`.
 *
 * A pure function of an env object, following `resolveGitHubWebConfig`, and for
 * the same reason: `next build` runs in CI with no collector, no
 * `OTEL_EXPORTER_OTLP_ENDPOINT` and no network, and a configuration reader that
 * throws on a missing or malformed variable would take that build down. This
 * one cannot throw. A malformed endpoint resolves to `disabled` with a stated
 * reason instead, because the alternative - an unparseable URL discovered on
 * the first request - is a 500 on a page that has nothing to do with telemetry.
 *
 * The web app's stake differs from the worker's in one way worth stating. The
 * worker's `off` costs visibility into work that still happens; the web app's
 * `off` costs the *link* between a click and the run it caused, which is the
 * whole point of Stage 3 storing a `traceparent` on the job. Neither is worth
 * refusing to start over.
 *
 * Stage 2 resolves the configuration and stops there - nothing here registers
 * an SDK yet. Stage 3 is what gives the request spans somewhere to go.
 */

export type WebTelemetryConfig =
  | {
      enabled: true;
      /** Base URL of the collector; the adapter appends `/v1/traces`. */
      endpoint: string;
      serviceName: string;
      serviceVersion: string;
      environment: string;
    }
  | { enabled: false; reason: TelemetryDisabledReason };

/** Why telemetry is unavailable, in the words a startup line would use. */
export type TelemetryDisabledReason = "disabled" | "unconfigured";

export const TELEMETRY_DISABLED_MESSAGE: Record<TelemetryDisabledReason, string> = {
  disabled: "Telemetry is turned off. Set RIVET_TELEMETRY=otlp to export traces and metrics.",
  unconfigured:
    "OTEL_EXPORTER_OTLP_ENDPOINT is not an absolute URL. Set it to a collector base URL, e.g. http://localhost:4318.",
};

/** The `service.name` the web app's spans and metrics carry. */
export const WEB_SERVICE_NAME = "rivet-web";

/** Matches the worker's default: the OTLP/HTTP port on this machine. */
export const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";

/** The subset of an environment this module reads, so tests can pass a literal. */
export type TelemetryWebEnv = Partial<Record<string, string>>;

export function resolveWebTelemetryConfig(env: TelemetryWebEnv = process.env): WebTelemetryConfig {
  if (env.RIVET_TELEMETRY?.trim() !== "otlp") return { enabled: false, reason: "disabled" };

  const endpoint = nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT) ?? DEFAULT_OTLP_ENDPOINT;
  if (!isAbsoluteHttpUrl(endpoint)) return { enabled: false, reason: "unconfigured" };

  return {
    enabled: true,
    // Trailing slashes stripped here rather than at every use site, so the two
    // signal URLs the adapter builds cannot end up with a doubled separator.
    endpoint: endpoint.replace(/\/+$/, ""),
    serviceName: WEB_SERVICE_NAME,
    serviceVersion: nonEmpty(env.RIVET_SERVICE_VERSION) ?? "0.0.0-dev",
    // `NODE_ENV`, the same source the worker reads, so one deployment's two
    // processes cannot disagree about which environment they are.
    environment: nonEmpty(env.NODE_ENV) ?? "development",
  };
}

/**
 * A set-but-blank variable means unset.
 *
 * `.env` files are full of blank placeholders, and `OTEL_EXPORTER_OTLP_ENDPOINT=""`
 * asking for an empty endpoint rather than the default would be a surprise.
 * `parseWorkerConfig` drops empty strings before Zod sees them for the same
 * reason.
 */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
