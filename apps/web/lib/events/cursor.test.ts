import { describe, expect, it } from "vitest";

import { parseEventCursor, resolveEventCursor } from "./cursor";

describe("parseEventCursor", () => {
  it("treats missing and empty values as no cursor", () => {
    expect(parseEventCursor(null)).toBeNull();
    expect(parseEventCursor(undefined)).toBeNull();
    expect(parseEventCursor(" ")).toBeNull();
  });

  it("accepts safe non-negative integer ids", () => {
    expect(parseEventCursor("0")).toBe(0);
    expect(parseEventCursor(" 42 ")).toBe(42);
    expect(parseEventCursor(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(["-1", "1.5", String(Number.MAX_SAFE_INTEGER + 1), "not-an-id"])(
    "rejects %s",
    (value) => {
      expect(parseEventCursor(value)).toBeUndefined();
    },
  );
});

describe("resolveEventCursor", () => {
  it("uses whichever cursor is newer", () => {
    expect(resolveEventCursor("10", "12")).toBe(12);
    expect(resolveEventCursor("12", "10")).toBe(12);
  });

  it("falls back to the cursor that was supplied", () => {
    expect(resolveEventCursor("10", null)).toBe(10);
    expect(resolveEventCursor(null, "12")).toBe(12);
    expect(resolveEventCursor(null, null)).toBeNull();
  });

  it("rejects a malformed value even when the other cursor is valid", () => {
    expect(resolveEventCursor("10", "1.5")).toBeUndefined();
    expect(resolveEventCursor("junk", "12")).toBeUndefined();
  });
});
