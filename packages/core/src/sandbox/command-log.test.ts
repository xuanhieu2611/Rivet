import type { Executor, NewJobCommandRow } from "@rivet/database";
import { describe, expect, it } from "vitest";

import type { Redactor } from "../telemetry/redaction";
import { recordCommand, truncate } from "./command-log";
import type { ExecResult } from "./sandbox";

/**
 * The writer tests use a capturing executor, so they still run without a
 * database while asserting the durable redaction boundary.
 */

function capturingExecutor(): { executor: Executor; values: NewJobCommandRow[] } {
  const values: NewJobCommandRow[] = [];
  const executor = {
    insert: () => ({
      values: (row: NewJobCommandRow) => {
        values.push(row);
        return { returning: () => Promise.resolve([{ ...row, id: 1, createdAt: new Date(0) }]) };
      },
    }),
  } as unknown as Executor;
  return { executor, values };
}

const SECRET = "sentinel-secret-value";
const redactor: Redactor = {
  redact: (value) => value.split(SECRET).join("[REDACTED]"),
  redactDeep: (value) => {
    if (typeof value === "string") return value.split(SECRET).join("[REDACTED]");
    if (Array.isArray(value)) return value.map((entry) => redactor.redactDeep(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, redactor.redactDeep(entry)]),
      );
    }
    return value;
  },
};

const result: ExecResult = {
  argv: ["printf", SECRET],
  cwd: `/workspace/${SECRET}`,
  exitCode: 0,
  stdout: `public-sentinel ${SECRET}`,
  stderr: "",
  truncated: false,
  timedOut: false,
  oomKilled: false,
  durationMs: 4,
};
describe("recordCommand", () => {
  it("redacts every durable command string", async () => {
    const capture = capturingExecutor();

    await recordCommand(
      {
        jobId: "11111111-2222-3333-4444-555555555555",
        phase: "testing",
        result,
        redactor,
      },
      capture.executor,
    );

    const stored = capture.values[0];
    expect(stored?.argv).toEqual(["printf", "[REDACTED]"]);
    expect(stored?.cwd).toBe("/workspace/[REDACTED]");
    expect(stored?.stdout).toBe("public-sentinel [REDACTED]");
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(JSON.stringify(stored)).toContain("public-sentinel");
  });
});

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
