import { describe, expect, it } from "vitest";

import { parseInstallationId, parseRepoRef } from "./params";

describe("parseInstallationId", () => {
  it("accepts a positive integer", () => {
    expect(parseInstallationId("42")).toBe(42);
  });

  it("rejects anything that is not one", () => {
    for (const raw of [null, "", "  ", "0", "-1", "1.5", "abc", "9007199254740993"]) {
      expect(parseInstallationId(raw)).toBeUndefined();
    }
  });
});

describe("parseRepoRef", () => {
  it("requires owner and name together, exactly as createJobSchema does", () => {
    expect(parseRepoRef(new URLSearchParams("owner=acme&name=widgets"))).toEqual({
      owner: "acme",
      name: "widgets",
    });
    expect(parseRepoRef(new URLSearchParams("owner=acme"))).toBeUndefined();
    expect(parseRepoRef(new URLSearchParams("name=widgets"))).toBeUndefined();
    expect(parseRepoRef(new URLSearchParams("owner=+&name=widgets"))).toBeUndefined();
  });
});
