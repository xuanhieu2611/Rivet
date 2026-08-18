import { describe, expect, it } from "vitest";

import { DEFAULT_OTLP_ENDPOINT, resolveWebTelemetryConfig } from "./config";

describe("resolveWebTelemetryConfig", () => {
  it("defaults to disabled, so a machine with no configuration still builds", () => {
    // The property `next build` in CI depends on: no collector, no variables,
    // no throw.
    expect(resolveWebTelemetryConfig({})).toEqual({ enabled: false, reason: "disabled" });
  });

  it("treats any mode other than otlp as off", () => {
    expect(resolveWebTelemetryConfig({ RIVET_TELEMETRY: "off" }).enabled).toBe(false);
    expect(resolveWebTelemetryConfig({ RIVET_TELEMETRY: "  " }).enabled).toBe(false);
  });

  it("falls back to the local collector when no endpoint is given", () => {
    expect(resolveWebTelemetryConfig({ RIVET_TELEMETRY: "otlp", NODE_ENV: "production" })).toEqual({
      enabled: true,
      endpoint: DEFAULT_OTLP_ENDPOINT,
      serviceName: "rivet-web",
      serviceVersion: "0.0.0-dev",
      environment: "production",
    });
  });

  it("strips the trailing slash, so the two signal URLs cannot double up", () => {
    const config = resolveWebTelemetryConfig({
      RIVET_TELEMETRY: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
    });
    expect(config).toMatchObject({ enabled: true, endpoint: "http://collector:4318" });
  });

  it("reports a malformed endpoint separately from being turned off", () => {
    // Different problems with different fixes. Collapsing them would send
    // somebody to change a switch that is already correct - and reporting it
    // here rather than throwing keeps an unparseable URL from becoming a 500 on
    // a page that has nothing to do with telemetry.
    for (const endpoint of ["not-a-url", "localhost:4318", "grpc://collector:4317"]) {
      expect(
        resolveWebTelemetryConfig({
          RIVET_TELEMETRY: "otlp",
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        }),
        endpoint,
      ).toEqual({ enabled: false, reason: "unconfigured" });
    }
  });

  it("carries the build's version through when one is set", () => {
    expect(
      resolveWebTelemetryConfig({
        RIVET_TELEMETRY: "otlp",
        RIVET_SERVICE_VERSION: "abc1234",
        NODE_ENV: "test",
      }),
    ).toMatchObject({ serviceVersion: "abc1234", environment: "test" });
  });
});
