import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PHASES, RUN, RUN_LINES, formatClock, revealDelayMs } from "./run-script";

const FIXTURE = fileURLToPath(
  new URL("../../../demo/replays/booking/events.ndjson", import.meta.url),
);
const JOB = fileURLToPath(new URL("../../../demo/replays/booking/job.json", import.meta.url));

interface FixtureEvent {
  offsetMs: number;
  type: string;
  message: string;
}

async function loadEvents(): Promise<FixtureEvent[]> {
  const text = await readFile(FIXTURE, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FixtureEvent);
}

describe("hero console script", () => {
  it("only shows events that exist in the recorded booking job", async () => {
    const events = await loadEvents();
    for (const line of RUN_LINES) {
      const match = events.find((event) => event.offsetMs === line.at && event.type === line.type);
      expect(match, `${line.type} at ${String(line.at)}ms ("${line.text}")`).toBeDefined();
    }
  });

  it("is in recorded order and ends with the job completing", () => {
    for (let index = 1; index < RUN_LINES.length; index += 1) {
      expect(RUN_LINES[index]!.at).toBeGreaterThanOrEqual(RUN_LINES[index - 1]!.at);
    }
    expect(RUN_LINES.at(-1)?.type).toBe("job.completed");
    expect(RUN_LINES.at(-1)?.at).toBe(RUN.durationMs);
  });

  it("visits every phase in pipeline order", () => {
    const order = PHASES.map((phase) => phase.id);
    const seen = [...new Set(RUN_LINES.map((line) => line.phase))];
    expect(seen).toEqual(order);
  });

  it("quotes the job's recorded totals", async () => {
    const job = JSON.parse(await readFile(JOB, "utf8")) as {
      facts: { totalCostUsd: string; totalModelCalls: number; pullRequestUrl: string };
    };
    expect(RUN.costUsd).toBe(job.facts.totalCostUsd);
    expect(RUN.modelCalls).toBe(job.facts.totalModelCalls);
    expect(RUN.pullRequestUrl).toBe(job.facts.pullRequestUrl);
  });

  it("formats the elapsed clock and keeps playback short", () => {
    expect(formatClock(RUN.durationMs)).toBe("07:32");
    const total = RUN_LINES.reduce((sum, _line, index) => sum + revealDelayMs(index), 0);
    expect(total).toBeGreaterThan(10_000);
    expect(total).toBeLessThan(30_000);
  });
});
