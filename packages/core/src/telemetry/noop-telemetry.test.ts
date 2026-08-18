import { describe, expect, it } from "vitest";

import { NOOP_TELEMETRY } from "./noop-telemetry";

describe("NOOP_TELEMETRY", () => {
  it("records nothing and reports no trace context", () => {
    const span = NOOP_TELEMETRY.startSpan("phase.testing", {
      kind: "internal",
      attributes: { "rivet.job_id": "job-1" },
    });
    span.setAttribute("rivet.attempt", 2);
    span.setAttributes({ "rivet.check": "test" });
    span.recordException(new Error("boom"));
    span.setStatus("error", "boom");
    span.end();

    expect(span.traceContext()).toBeUndefined();
    expect(NOOP_TELEMETRY.traceContext()).toBeUndefined();
  });

  it("accepts every instrument without throwing", () => {
    NOOP_TELEMETRY.counter("rivet.jobs.completed", { unit: "1" }).add(1, { status: "succeeded" });
    NOOP_TELEMETRY.histogram("rivet.job.duration", { unit: "ms" }).record(1234);
    NOOP_TELEMETRY.gauge("rivet.jobs.active").record(3);
  });

  it("returns the body's value from withSpan", async () => {
    await expect(NOOP_TELEMETRY.withSpan("phase.analyzing", undefined, () => 7)).resolves.toBe(7);
    await expect(
      NOOP_TELEMETRY.withSpan("phase.analyzing", undefined, () => Promise.resolve("ok")),
    ).resolves.toBe("ok");
  });

  it("rethrows unchanged, so telemetry can never swallow a job failure", async () => {
    const failure = new Error("provider refused");
    await expect(
      NOOP_TELEMETRY.withSpan("agent.session", undefined, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("shares one instrument per kind, because none of them hold state", () => {
    expect(NOOP_TELEMETRY.counter("a")).toBe(NOOP_TELEMETRY.counter("b"));
    expect(NOOP_TELEMETRY.histogram("a")).toBe(NOOP_TELEMETRY.histogram("b"));
    expect(NOOP_TELEMETRY.gauge("a")).toBe(NOOP_TELEMETRY.gauge("b"));
  });
});
