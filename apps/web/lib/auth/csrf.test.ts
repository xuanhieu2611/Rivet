import { describe, expect, it } from "vitest";

import { csrfFailure } from "./csrf";

describe("same-origin mutation checks", () => {
  it("accepts a same-origin browser request", () => {
    const request = new Request("https://rivet.test/api/jobs", {
      method: "POST",
      headers: { Host: "rivet.test", Origin: "https://rivet.test" },
    });
    expect(csrfFailure(request)).toBeNull();
  });

  it("rejects a cross-origin request", () => {
    const request = new Request("https://rivet.test/api/jobs", {
      method: "POST",
      headers: { Host: "rivet.test", Origin: "https://attacker.test" },
    });
    expect(csrfFailure(request)?.status).toBe(403);
  });

  it("rejects a mismatched Host header", () => {
    const request = new Request("https://rivet.test/api/jobs", {
      method: "POST",
      headers: { Host: "attacker.test" },
    });
    expect(csrfFailure(request)?.status).toBe(403);
  });
});
