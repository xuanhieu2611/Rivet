import type { JobDetail } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { ValidationConfigInvalidError } from "../jobs/failure";
import { CommandTimedOutError } from "../sandbox/errors";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import type { PhaseContext, PhaseExecInput, RecordedCommand } from "./phase-context";
import { probeValidation } from "./project-probe";

const REPO_DIR = "/workspace/repo";
const JOB = { id: "11111111-2222-3333-4444-555555555555" } as JobDetail;

type Responder = (input: PhaseExecInput) => Partial<RecordedCommand> | undefined;

function harness(respond?: Responder) {
  const executed: PhaseExecInput[] = [];
  const ctx = {
    job: JOB,
    phase: { status: "analyzing", label: "probe", durationMs: 0, recovery: "replay" },
    sandboxes: new SandboxHolder(),
    signal: new AbortController().signal,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    exec: (input: PhaseExecInput) => {
      executed.push(input);
      const scripted = respond?.(input) ?? defaultResponse(input);
      return Promise.resolve({
        argv: input.argv,
        cwd: input.cwd,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        oomKilled: false,
        durationMs: 1,
        commandId: executed.length,
        commandExecutionId: `exec-${executed.length}`,
        ...scripted,
      });
    },
  } as unknown as PhaseContext;

  return {
    executed,
    run: () => probeValidation(ctx, { repoDir: REPO_DIR, commandTimeoutMs: 10_000 }),
  };
}

function defaultResponse(input: PhaseExecInput): Partial<RecordedCommand> | undefined {
  if (input.argv[0] === "ls") {
    return { stdout: ".\n..\npackage.json\npnpm-lock.yaml\n" };
  }
  if (input.argv[1] === "package.json") {
    return { stdout: JSON.stringify({ scripts: { test: "vitest run" } }) };
  }
  return undefined;
}

describe("probeValidation", () => {
  it("reads package.json and does not read an absent rivet.json", async () => {
    const test = harness();

    const resolved = await test.run();

    expect(resolved.test).toMatchObject({ source: "package_json" });
    expect(test.executed.map((input) => input.argv)).toEqual([
      ["ls", "-1", "-a", REPO_DIR],
      ["cat", "package.json"],
    ]);
  });

  it("reads and applies a present rivet.json", async () => {
    const test = harness((input) => {
      if (input.argv[0] === "ls") {
        return { stdout: ".\n..\npackage.json\npnpm-lock.yaml\nrivet.json\n" };
      }
      if (input.argv[1] === "rivet.json") {
        return { stdout: JSON.stringify({ validation: { lint: { argv: ["eslint", "."] } } }) };
      }
      return undefined;
    });

    const resolved = await test.run();

    expect(resolved.lint).toEqual({ argv: ["eslint", "."], source: "rivet_json" });
    expect(test.executed.at(-1)?.maxOutputBytes).toBeGreaterThan(65_536);
  });

  it("turns ordinary package read and parse failures into recorded skip reasons", async () => {
    const unreadable = harness((input) =>
      input.argv[1] === "package.json" ? { exitCode: 1 } : undefined,
    );
    await expect(unreadable.run()).resolves.toMatchObject({
      test: { skipped: true, reason: "package.json could not be read" },
    });

    const malformed = harness((input) =>
      input.argv[1] === "package.json" ? { stdout: "{ nope" } : undefined,
    );
    await expect(malformed.run()).resolves.toMatchObject({
      test: { skipped: true, reason: "package.json is not readable as JSON" },
    });
  });

  it("fails terminally when a present rivet.json is malformed or schema-invalid", async () => {
    const malformed = harness((input) => {
      if (input.argv[0] === "ls") {
        return { stdout: ".\n..\npackage.json\npnpm-lock.yaml\nrivet.json\n" };
      }
      if (input.argv[1] === "rivet.json") return { stdout: "{ nope" };
      return undefined;
    });
    await expect(malformed.run()).rejects.toBeInstanceOf(ValidationConfigInvalidError);

    const invalid = harness((input) => {
      if (input.argv[0] === "ls") {
        return { stdout: ".\n..\npackage.json\npnpm-lock.yaml\nrivet.json\n" };
      }
      if (input.argv[1] === "rivet.json") {
        return { stdout: JSON.stringify({ validation: { lint: "pnpm lint" } }) };
      }
      return undefined;
    });
    await expect(invalid.run()).rejects.toMatchObject({ category: "validation_config_invalid" });

    const jsonNull = harness((input) => {
      if (input.argv[0] === "ls") {
        return { stdout: ".\n..\npackage.json\npnpm-lock.yaml\nrivet.json\n" };
      }
      if (input.argv[1] === "rivet.json") return { stdout: "null" };
      return undefined;
    });
    await expect(jsonNull.run()).rejects.toMatchObject({ category: "validation_config_invalid" });
  });

  it("raises a killed rivet.json read instead of reclassifying it", async () => {
    const test = harness((input) => {
      if (input.argv[0] === "ls") {
        return { stdout: ".\n..\npackage.json\npnpm-lock.yaml\nrivet.json\n" };
      }
      if (input.argv[1] === "rivet.json") {
        return { exitCode: null, timedOut: true };
      }
      return undefined;
    });

    await expect(test.run()).rejects.toBeInstanceOf(CommandTimedOutError);
  });
});
