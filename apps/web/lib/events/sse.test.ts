import { describe, expect, it } from "vitest";

import { encodeSseComment, encodeSseFrame, encodeSseRetry } from "./sse";

describe("encodeSseFrame", () => {
  it("writes an id, event, JSON data, and a terminating blank line", () => {
    expect(encodeSseFrame({ id: 1842, event: "job.event", data: { message: "started" } })).toBe(
      'id: 1842\nevent: job.event\ndata: {"message":"started"}\n\n',
    );
  });

  it("writes each line of string data as its own data field", () => {
    expect(encodeSseFrame({ data: "stdout\nstderr" })).toBe("data: stdout\ndata: stderr\n\n");
  });

  it("rejects values that could inject another SSE field", () => {
    expect(() => encodeSseFrame({ id: "42\nevent: forged" })).toThrow(/cannot contain a newline/);
  });
});

describe("SSE control frames", () => {
  it("encodes comments", () => {
    expect(encodeSseComment("keepalive")).toBe(": keepalive\n\n");
    expect(encodeSseComment("one\ntwo")).toBe(": one\n: two\n\n");
  });

  it("encodes the retry delay", () => {
    expect(encodeSseRetry(2_000)).toBe("retry: 2000\n\n");
  });
});
