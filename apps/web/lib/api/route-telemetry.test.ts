import { ATTR_REQUEST_ID, ATTR_ROUTE, RecordingTelemetry } from "@rivet/core";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const telemetry = new RecordingTelemetry();
vi.mock("../telemetry/telemetry", () => ({
  getWebTelemetry: () => telemetry,
  currentTraceContext: () => telemetry.traceContext(),
}));

const { withRoute } = await import("./route-telemetry");

function request(): Request {
  return new Request("http://localhost/api/jobs/11111111-2222-3333-4444-555555555555");
}

describe("withRoute", () => {
  beforeEach(() => {
    telemetry.reset();
  });

  it("opens one server span named for the route pattern, never the resolved path", async () => {
    const handler = withRoute("/api/jobs/:id", () =>
      Promise.resolve(NextResponse.json({ ok: true })),
    );

    await handler(request());

    const [span] = telemetry.spans;
    // The pattern, so a backend's operation list stays bounded. A span named
    // with the job id in it makes every aggregation useless.
    expect(span?.name).toBe("GET /api/jobs/:id");
    expect(span?.name).not.toContain("11111111");
    expect(span?.kind).toBe("server");
    expect(span?.attributes[ATTR_ROUTE]).toBe("/api/jobs/:id");
    expect(span?.attributes["http.response.status_code"]).toBe(200);
    expect(span?.ended).toBe(true);
  });

  it("gives the handler a request id that is also on the span", async () => {
    let seen: string | undefined;
    const handler = withRoute("/api/jobs", (_request, context) => {
      seen = context.requestId;
      return Promise.resolve(NextResponse.json({}));
    });

    await handler(request());

    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    expect(telemetry.spans[0]?.attributes[ATTR_REQUEST_ID]).toBe(seen);
  });

  it("makes the span active for the handler, which is what stamps jobs.trace_context", async () => {
    let seen: string | undefined;
    const handler = withRoute("/api/jobs", async (_request, _context) => {
      const { currentTraceContext } = await import("../telemetry/telemetry");
      seen = currentTraceContext();
      return NextResponse.json({});
    });

    await handler(request());

    expect(seen).toBe(telemetry.spans[0]?.traceContext());
  });

  it("passes the framework's own arguments through to the handler", async () => {
    let params: unknown;
    const handler = withRoute<[{ params: Promise<{ id: string }> }]>(
      "/api/jobs/:id",
      async (_request, _context, context) => {
        params = await context.params;
        return NextResponse.json({});
      },
    );

    await handler(request(), { params: Promise.resolve({ id: "abc" }) });

    expect(params).toEqual({ id: "abc" });
  });

  it("records a throw on the span and rethrows it, changing nothing about the outcome", async () => {
    const failure = new Error("column does not exist");
    const handler = withRoute("/api/jobs", () => Promise.reject(failure));

    await expect(handler(request())).rejects.toBe(failure);

    const [span] = telemetry.spans;
    expect(span?.status).toBe("error");
    expect(span?.exceptions[0]?.error).toBe(failure);
    expect(span?.ended).toBe(true);
  });
});
