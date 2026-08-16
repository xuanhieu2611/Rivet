import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "./logger";
import { REDACTED, SecretRegistry } from "./secrets";

const SENTINEL = "ghs_sentineltokenvalue0123456789";

/** Captures what pino actually wrote, which is the only thing that matters. */
function captureLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLogger", () => {
  it("redacts a registered secret from the line it writes", () => {
    const secrets = new SecretRegistry();
    secrets.add(SENTINEL);
    const { lines, restore } = captureLines();

    createLogger("info", "worker-1", secrets).info(
      { remote: `https://x-access-token:${SENTINEL}@github.com/acme/widgets` },
      `pushing with ${SENTINEL}`,
    );
    restore();

    const written = lines.join("");
    expect(written).not.toContain(SENTINEL);
    expect(written).toContain(REDACTED);
  });

  it("redacts a secret quoted back inside an error", () => {
    // The realistic path: nothing here logs a token deliberately, and a
    // provider or a child process quoting the request it was given is how one
    // reaches a log line anyway.
    const secrets = new SecretRegistry();
    secrets.add(SENTINEL);
    const { lines, restore } = captureLines();

    createLogger("info", "worker-1", secrets).error(
      { err: new Error(`fatal: could not read Password for ${SENTINEL}`) },
      "publication failed",
    );
    restore();

    expect(lines.join("")).not.toContain(SENTINEL);
  });

  it("writes ordinary lines untouched when nothing is registered", () => {
    const { lines, restore } = captureLines();

    createLogger("info", "worker-1", new SecretRegistry()).info({ jobId: "abc" }, "worker started");
    restore();

    const written = lines.join("");
    expect(written).toContain("worker started");
    expect(written).not.toContain(REDACTED);
  });
});
