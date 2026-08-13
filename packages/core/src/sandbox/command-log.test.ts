import { describe, expect, it } from "vitest";

import { truncate } from "./command-log";

/**
 * `recordCommand` is not tested here: it is an insert, and the unit suite runs
 * with no database. `truncate` is the part with logic in it, and it is pure.
 */
describe("truncate", () => {
  it("leaves output under the cap alone", () => {
    const result = truncate("hello", 64);
    expect(result).toEqual({ text: "hello", truncated: false, elidedBytes: 0 });
  });

  it("leaves output exactly at the cap alone", () => {
    const result = truncate("0123456789", 10);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("0123456789");
  });

  it("keeps the head and the tail of output over the cap", () => {
    const result = truncate("a".repeat(50) + "b".repeat(50), 20);

    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("a".repeat(10))).toBe(true);
    expect(result.text.endsWith("b".repeat(10))).toBe(true);
  });

  it("states how many bytes it dropped", () => {
    const result = truncate("x".repeat(1000), 100);

    expect(result.elidedBytes).toBe(900);
    expect(result.text).toContain("... 900 bytes elided ...");
  });

  it("keeps the end, which is where a failing command says why", () => {
    const noise = "warning: something\n".repeat(500);
    const result = truncate(`${noise}Error: the last line is the useful one\n`, 200);

    expect(result.text).toContain("Error: the last line is the useful one");
  });

  it("never cuts a multi-byte character in half", () => {
    // Four bytes each, so every candidate cut point lands mid-character.
    const text = "🚀".repeat(100);
    const result = truncate(text, 30);

    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("�");
    // Three whole rockets each side. Backing both ends off to a boundary is
    // what costs the six bytes between that and the cap of thirty.
    const kept = result.text.replace(`\n... ${result.elidedBytes} bytes elided ...\n`, "");
    expect(Buffer.from(kept, "utf8").byteLength).toBe(24);
  });

  it("counts the cap in bytes, not in characters", () => {
    // Ten characters, thirty bytes: over a cap of twenty.
    const result = truncate("é".repeat(10) + "🚀".repeat(5), 20);
    expect(result.truncated).toBe(true);
  });

  it("keeps nothing but the marker at a cap of zero", () => {
    const result = truncate("hello", 0);

    expect(result.truncated).toBe(true);
    expect(result.elidedBytes).toBe(5);
    expect(result.text.trim()).toBe("... 5 bytes elided ...");
  });

  it("adds up: what was kept plus what was elided is what came in", () => {
    const text = "line\n".repeat(1000);
    const result = truncate(text, 137);
    const kept = result.text.replace(`\n... ${result.elidedBytes} bytes elided ...\n`, "");

    expect(Buffer.from(kept, "utf8").byteLength + result.elidedBytes).toBe(
      Buffer.from(text, "utf8").byteLength,
    );
  });
});
