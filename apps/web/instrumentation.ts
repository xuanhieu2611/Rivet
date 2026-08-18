/**
 * Next's one hook that runs before anything is served.
 *
 * The SDK has to register before the first request opens a span, and this is
 * the only place in the App Router that is guaranteed to run once per server
 * process. Doing it lazily from the first route handler would work for spans
 * and not for the global context manager, which has to be in place before any
 * `context.with` runs or a nested span would come out as a root.
 *
 * Guarded on the Node.js runtime because `register` is also called for the edge
 * runtime, where the SDK's async-hooks context manager does not exist. Nothing
 * in this app runs on edge - the `pg` Pool cannot - but the hook is called
 * regardless, and a throw here takes the whole server down.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Imported dynamically so the edge bundle never pulls the SDK in at all.
  const { getWebTelemetry } = await import("./lib/telemetry/telemetry");
  getWebTelemetry();
}
