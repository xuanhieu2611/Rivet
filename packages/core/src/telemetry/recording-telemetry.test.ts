import { describe, expect, it } from "vitest";

import { NOOP_TELEMETRY } from "./noop-telemetry";
import { RecordedSpan, RecordingTelemetry } from "./recording-telemetry";

describe("RecordingTelemetry", () => {
  it("nests spans opened inside a withSpan body under it", async () => {
    const telemetry = new RecordingTelemetry();

    await telemetry.withSpan("phase.testing", { attributes: { "rivet.job_id": "job-1" } }, () =>
      telemetry.withSpan("sandbox.command", undefined, async () => {
        await telemetry.withSpan("agent.tool", undefined, () => undefined);
      }),
    );

    expect(telemetry.spanNames()).toEqual(["phase.testing", "sandbox.command", "agent.tool"]);
    const [phase, command, tool] = telemetry.spans;
    expect(phase?.parent).toBeUndefined();
    expect(command?.parent).toBe(phase);
    expect(tool?.parent).toBe(command);
    expect(phase?.children).toEqual([command]);
    expect(telemetry.rootSpans()).toEqual([phase]);
  });

  it("gives a child its parent's trace id and a fresh span id", async () => {
    const telemetry = new RecordingTelemetry();

    await telemetry.withSpan("job.run", undefined, () =>
      telemetry.withSpan("phase.planning", undefined, () => undefined),
    );

    const [root, child] = telemetry.spans;
    expect(child?.traceId).toBe(root?.traceId);
    expect(child?.spanId).not.toBe(root?.spanId);
    expect(root?.traceContext()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("starts a new trace for each root, which is what makes attempts siblings", () => {
    const telemetry = new RecordingTelemetry();

    const first = telemetry.startSpan("job.run");
    first.end();
    const second = telemetry.startSpan("job.run", {
      links: [{ traceContext: first.traceContext() ?? "" }],
    });
    second.end();

    const [a, b] = telemetry.spans;
    expect(a?.traceId).not.toBe(b?.traceId);
    expect(b?.links).toEqual([{ traceContext: a?.traceContext() }]);
  });

  it("reports the innermost open span as the active trace context", async () => {
    const telemetry = new RecordingTelemetry();
    expect(telemetry.traceContext()).toBeUndefined();

    await telemetry.withSpan("job.run", undefined, async (outer) => {
      expect(telemetry.traceContext()).toBe(outer.traceContext());
      await telemetry.withSpan("phase.analyzing", undefined, (inner) => {
        expect(telemetry.traceContext()).toBe(inner.traceContext());
      });
      expect(telemetry.traceContext()).toBe(outer.traceContext());
    });

    expect(telemetry.traceContext()).toBeUndefined();
  });

  it("ends the span and records the error when the body throws", async () => {
    const telemetry = new RecordingTelemetry();
    const failure = new Error("pnpm install exited 1");

    await expect(
      telemetry.withSpan("phase.provisioning", undefined, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    const [span] = telemetry.spans;
    expect(span?.ended).toBe(true);
    expect(span?.status).toBe("error");
    expect(span?.statusMessage).toBe("Error: pnpm install exited 1");
    expect(span?.exceptions).toEqual([{ error: failure, message: "Error: pnpm install exited 1" }]);
    expect(telemetry.openSpans()).toEqual([]);
  });

  it("describes a thrown non-error rather than losing it", async () => {
    const telemetry = new RecordingTelemetry();

    // A string, because a provider adapter that rejects with one is a real
    // path and a span that recorded `[object Object]` for it would be useless.
    const thrown: unknown = "rate limited";
    await expect(
      telemetry.withSpan("agent.session", undefined, () => {
        throw thrown;
      }),
    ).rejects.toBe("rate limited");

    expect(telemetry.spans[0]?.exceptions[0]?.message).toBe("rate limited");
  });

  it("leaves a successful span's status unset, the OTel convention", async () => {
    const telemetry = new RecordingTelemetry();
    await telemetry.withSpan("phase.finalizing", undefined, () => undefined);
    expect(telemetry.spans[0]?.status).toBe("unset");
  });

  it("drops attributes explicitly set to undefined", () => {
    const telemetry = new RecordingTelemetry();

    const span = telemetry.startSpan("job.run", {
      attributes: { "rivet.job_id": "job-1", "rivet.pull_request_number": undefined },
    });
    span.setAttribute("rivet.attempt", 2);
    span.setAttribute("rivet.branch", undefined);
    span.setAttributes({ "rivet.review_decision": undefined, "rivet.review_loops": 1 });
    span.end();

    expect(span instanceof RecordedSpan && span.attributes).toEqual({
      "rivet.job_id": "job-1",
      "rivet.attempt": 2,
      "rivet.review_loops": 1,
    });
  });

  it("measures duration off the injected clock", () => {
    const telemetry = new RecordingTelemetry();
    const span = telemetry.startSpan("phase.implementing");
    span.end(1_000);
    expect((span as RecordedSpan).startTime).toBe(1);
    expect((span as RecordedSpan).durationMs).toBe(999);
  });

  it("ignores a second end rather than moving the duration", () => {
    const telemetry = new RecordingTelemetry();
    const span = telemetry.startSpan("phase.implementing");
    span.end(10);
    span.end(99);
    expect((span as RecordedSpan).endTime).toBe(10);
  });

  it("records every instrument observation with its attributes", () => {
    const telemetry = new RecordingTelemetry();

    telemetry.counter("rivet.job.cost_usd").add(0.5, { arm: "review" });
    telemetry.counter("rivet.job.cost_usd").add(0.25, { arm: "none", ignored: undefined });
    telemetry.histogram("rivet.job.duration_ms").record(1234);
    telemetry.gauge("rivet.jobs.active").record(3);

    expect(telemetry.measurements).toEqual([
      { kind: "counter", name: "rivet.job.cost_usd", value: 0.5, attributes: { arm: "review" } },
      { kind: "counter", name: "rivet.job.cost_usd", value: 0.25, attributes: { arm: "none" } },
      { kind: "histogram", name: "rivet.job.duration_ms", value: 1234, attributes: {} },
      { kind: "gauge", name: "rivet.jobs.active", value: 3, attributes: {} },
    ]);
    expect(telemetry.total("rivet.job.cost_usd")).toBe(0.75);
    expect(telemetry.measurementsNamed("rivet.jobs.active")).toHaveLength(1);
  });

  it("returns one instrument per name and kind", () => {
    const telemetry = new RecordingTelemetry();
    expect(telemetry.counter("x")).toBe(telemetry.counter("x"));
    expect(telemetry.counter("x")).not.toBe(telemetry.counter("y"));
    expect(telemetry.counter("x")).not.toBe(telemetry.histogram("x"));
  });

  it("honours an explicit parent over the enclosing span", async () => {
    const telemetry = new RecordingTelemetry();

    const root = telemetry.startSpan("job.run");
    await telemetry.withSpan("phase.testing", undefined, () => {
      telemetry.startSpan("sandbox.command", { parent: root }).end();
    });
    root.end();

    const command = telemetry.spansNamed("sandbox.command")[0];
    expect(command?.parent?.name).toBe("job.run");
  });

  it("refuses a parent span from another telemetry implementation", () => {
    const telemetry = new RecordingTelemetry();
    expect(() =>
      telemetry.startSpan("phase.testing", { parent: NOOP_TELEMETRY.startSpan("job.run") }),
    ).toThrow(/did not create/);
  });

  it("survives spans ended out of order", () => {
    const telemetry = new RecordingTelemetry();
    const outer = telemetry.startSpan("job.run");
    const inner = telemetry.startSpan("phase.testing");

    outer.end();
    expect(telemetry.traceContext()).toBe(inner.traceContext());
    inner.end();
    expect(telemetry.traceContext()).toBeUndefined();
  });

  it("reports spans that were never ended", () => {
    const telemetry = new RecordingTelemetry();
    telemetry.startSpan("job.run");
    expect(telemetry.openSpans().map((span) => span.name)).toEqual(["job.run"]);
  });

  it("clears recorded state on reset", async () => {
    const telemetry = new RecordingTelemetry();
    await telemetry.withSpan("job.run", undefined, () => undefined);
    telemetry.counter("c").add(1);

    telemetry.reset();

    expect(telemetry.spans).toEqual([]);
    expect(telemetry.measurements).toEqual([]);
    expect(telemetry.traceContext()).toBeUndefined();
  });
});
