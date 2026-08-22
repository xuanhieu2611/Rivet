import type { JobEvent, JobEventType } from "@rivet/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExecutionTimeline } from "@/components/execution-timeline";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

function event(id: number, type: JobEventType, message: string, data: JobEvent["data"]): JobEvent {
  return { id, jobId: JOB_ID, type, message, data, createdAt: CREATED_AT };
}

function commandPair(id: number, executionId: string, argv: string[], exitCode = 0): JobEvent[] {
  return [
    event(id, "command.started", `${argv.join(" ")} started`, {
      argv,
      phase: "Create plan",
      cwd: "/workspace/repo",
      commandExecutionId: executionId,
    }),
    event(id + 1, "command.completed", `${argv.join(" ")} exited ${String(exitCode)}`, {
      argv,
      phase: "Create plan",
      exitCode,
      durationMs: 13,
      commandId: id,
      commandExecutionId: executionId,
    }),
  ];
}

describe("ExecutionTimeline command folding", () => {
  it("pairs and folds consecutive successful commands from one phase", () => {
    const html = renderToStaticMarkup(
      createElement(ExecutionTimeline, {
        events: [
          ...commandPair(1, "command-a", ["git", "ls-files"]),
          ...commandPair(3, "command-b", ["head", "-c", "4096", "README.md"]),
          ...commandPair(5, "command-c", ["cat", "package.json"]),
        ],
      }),
    );

    expect(html).toContain('data-command-group-count="3"');
    expect(html).toContain("Create plan");
    expect(html).toContain("3 sandbox commands");
    expect(html).toContain("All succeeded · 39ms");
    expect(html).toContain("git ls-files");
    expect(html).toContain("head -c 4096 README.md");
    expect(html).toContain("cat package.json");
    expect(html.match(/>Transcript<\/a>/g)).toHaveLength(3);
    expect(html).not.toContain("git ls-files exited 0");
  });

  it("keeps running, non-zero, and failed commands visible as individual rows", () => {
    const html = renderToStaticMarkup(
      createElement(ExecutionTimeline, {
        events: [
          event(1, "command.started", "npm test started", {
            argv: ["npm", "test"],
            phase: "Validate change",
            commandExecutionId: "running",
          }),
          ...commandPair(2, "non-zero", ["git", "grep", "missing"], 1),
          event(4, "command.started", "node script.js started", {
            argv: ["node", "script.js"],
            phase: "Validate change",
            commandExecutionId: "failed",
          }),
          event(5, "command.failed", "sandbox command failed", {
            argv: ["node", "script.js"],
            phase: "Validate change",
            error: "container stopped",
            commandExecutionId: "failed",
          }),
        ],
      }),
    );

    expect(html).not.toContain("data-command-group-count");
    expect(html).toContain("npm test");
    expect(html).toContain("Running");
    expect(html).toContain("git grep missing");
    expect(html).toContain("Exit 1");
    expect(html).toContain("node script.js");
    expect(html).toContain("Failed");
    expect(html).toContain("sandbox command failed");
  });
});
