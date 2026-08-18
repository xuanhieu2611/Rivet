import type { JobEventData } from "@rivet/contracts";
import type { Executor, NewJobEventRow } from "@rivet/database";
import { describe, expect, it } from "vitest";

import { appendEvent } from "./event-service";

const SECRET = "sentinel-secret-value";
const redactor = {
  redact: (value: string) => value.split(SECRET).join("[REDACTED]"),
  redactDeep(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((entry) => this.redactDeep(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.redactDeep(entry)]),
      );
    }
    return value;
  },
};

function capturingExecutor(): { executor: Executor; values: NewJobEventRow[] } {
  const values: NewJobEventRow[] = [];
  const executor = {
    insert: () => ({
      values: (row: NewJobEventRow) => {
        values.push(row);
        return { returning: () => Promise.resolve([{ ...row, id: 1, createdAt: new Date(0) }]) };
      },
    }),
  } as unknown as Executor;
  return { executor, values };
}

describe("appendEvent", () => {
  it("redacts the message and nested payload before persistence", async () => {
    const capture = capturingExecutor();

    await appendEvent(
      {
        jobId: "11111111-2222-3333-4444-555555555555",
        type: "job.created",
        message: `public-sentinel ${SECRET}`,
        data: {
          nested: { secret: SECRET, public: "public-sentinel" },
        } as unknown as JobEventData,
        redactor,
      },
      capture.executor,
    );

    const stored = capture.values[0];
    expect(stored?.message).toBe("public-sentinel [REDACTED]");
    expect(stored?.data).toEqual({
      nested: { secret: "[REDACTED]", public: "public-sentinel" },
    });
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(JSON.stringify(stored)).toContain("public-sentinel");
  });
});
