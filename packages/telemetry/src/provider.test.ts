import { describe, expect, it } from "vitest";

import { signalUrl } from "./provider";

describe("signalUrl", () => {
  it("appends the signal path to a base endpoint", () => {
    expect(signalUrl("http://localhost:4318", "traces")).toBe("http://localhost:4318/v1/traces");
    expect(signalUrl("http://localhost:4318", "metrics")).toBe("http://localhost:4318/v1/metrics");
  });

  it("tolerates the trailing slash everyone types", () => {
    expect(signalUrl("http://collector:4318///", "traces")).toBe("http://collector:4318/v1/traces");
  });
});
