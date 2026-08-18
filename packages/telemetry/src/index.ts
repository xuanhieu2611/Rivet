/**
 * `@rivet/telemetry` - the only package in Rivet that knows OpenTelemetry
 * exists.
 *
 * The fourth adapter, alongside `@rivet/queue`, `@rivet/sandbox` and
 * `@rivet/agent`. `@rivet/core` declares the `Telemetry` port and ships two
 * implementations of it - `NOOP_TELEMETRY` for a process with nowhere to send
 * anything, `RecordingTelemetry` for the tests - and this package supplies the
 * third, the one that actually exports.
 *
 * `@opentelemetry/api` is a facade that no-ops until a provider is registered,
 * so core *could* have imported it directly without breaking a test. Keeping it
 * out here is what makes "did this phase open a span with these attributes" an
 * ordinary unit assertion rather than something needing an SDK, an exporter and
 * a collector - and it keeps the rule that core depends on neither deployable's
 * delivery mechanism true in the dependency graph rather than only in a comment.
 *
 * The laziness rule applies unchanged: **importing this package opens no
 * connection and throws nothing.** Everything is a function.
 */

export { OtelTelemetry } from "./otel-telemetry";
export {
  DiagLogLevel,
  setTelemetryDiagnostics,
  signalUrl,
  startOtelTelemetry,
  type TelemetryHandle,
  type TelemetryOptions,
} from "./provider";
export { ATTR_RIVET_WORKER_ID, resourceAttributes, type ResourceOptions } from "./resource";
export { formatTraceParent, parseTraceParent } from "./trace-context";
