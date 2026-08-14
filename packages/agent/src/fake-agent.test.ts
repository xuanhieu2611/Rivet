import type { AgentToolbox, CodingAgentSpec, PlannerAgentToolbox } from "@rivet/core";
import { describe, expect, it } from "vitest";

import { FakeCodingAgent } from "./fake-agent";

/**
 * The fake, tested as carefully as the thing it stands in for.
 *
 * A test double that lies about its own contract is worse than no double at
 * all: every suite built on it passes while the property it was supposed to
 * demonstrate is untrue. The three that matter here are that a script is
 * delivered in order, that a hanging session actually stops when it is aborted,
 * and that `stop()` is idempotent - because the phase calls it from a `finally`
 * that has usually already run once.
 */

const SPEC: CodingAgentSpec = {
  role: "implementer",
  workdir: "/home/node/workspace/repo",
  task: { title: "Fix the off-by-one", description: "sum() is wrong." },
  context: "",
  sessionTimeoutMs: 1_000,
  commandTimeoutMs: 100,
  previewMaxBytes: 512,
  limits: { maxTurns: 4, maxToolCalls: 10, maxModelCalls: 10, maxCostUsd: 1 },
};

const TOOLBOX: AgentToolbox = {
  role: "implementer",
  readFile: () => Promise.resolve({ content: "", truncated: false }),
  writeFile: () => Promise.resolve(),
  exec: () => Promise.reject(new Error("not scripted")),
};

const PLANNER_SPEC: CodingAgentSpec = { ...SPEC, role: "planner" };

const PLANNER_TOOLBOX: PlannerAgentToolbox = {
  role: "planner",
  listFiles: () => Promise.resolve("src/index.ts"),
  readFile: () => Promise.resolve({ content: "source", truncated: false }),
  searchText: () => Promise.resolve("src/index.ts:1:source"),
  submitPlan: () => Promise.resolve(),
};

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  for await (const item of iterable) seen.push(item);
  return seen;
}

describe("FakeCodingAgent", () => {
  it("yields a script in order and records the spec it was given", async () => {
    const agent = new FakeCodingAgent({
      script: [
        {
          events: [
            { type: "turn_started", turn: 0 },
            { type: "turn_completed", turn: 0 },
          ],
        },
      ],
    });

    const session = await agent.start(SPEC, TOOLBOX, new AbortController().signal);
    const events = await collect(session.run(new AbortController().signal));

    expect(events).toHaveLength(2);
    expect(agent.starts[0]?.task.title).toBe("Fix the off-by-one");
  });

  it("submits a deterministic plan for a planner without a provider", async () => {
    let submitted: unknown;
    const plannerTools: PlannerAgentToolbox = {
      ...PLANNER_TOOLBOX,
      submitPlan: (value) => {
        submitted = value;
        return Promise.resolve();
      },
    };
    const agent = new FakeCodingAgent();
    const session = await agent.start(PLANNER_SPEC, plannerTools, new AbortController().signal);

    await collect(session.run(new AbortController().signal));

    expect(submitted).toBeTypeOf("object");
    expect(submitted).toHaveProperty("problemInterpretation");
    expect(submitted).toHaveProperty("relevantComponents");
    expect(submitted).toHaveProperty("reproductionStrategy");
    expect(submitted).toHaveProperty("implementationApproach");
    expect(submitted).toHaveProperty("validationPlan");
    expect(submitted).toHaveProperty("riskAreas");
  });

  it("runs a script's tool usage against the real toolbox", async () => {
    const written: string[] = [];
    const agent = new FakeCodingAgent({
      script: [
        {
          events: [],
          useTools: async (tools, signal) => {
            await tools.writeFile("/home/node/workspace/repo/a.ts", "x", signal);
          },
        },
      ],
    });

    const session = await agent.start(
      SPEC,
      { ...TOOLBOX, writeFile: (path) => (written.push(path), Promise.resolve()) },
      new AbortController().signal,
    );
    await collect(session.run(new AbortController().signal));

    expect(written).toEqual(["/home/node/workspace/repo/a.ts"]);
  });

  it("stops a hanging session when the run is aborted", async () => {
    const agent = new FakeCodingAgent({ script: [{ events: [], hang: true }] });
    const controller = new AbortController();
    const session = await agent.start(SPEC, TOOLBOX, new AbortController().signal);

    const running = collect(session.run(controller.signal));
    controller.abort(new Error("cancelled"));

    await expect(running).rejects.toThrow("cancelled");
  });

  it("throws what the script says it should", async () => {
    const agent = new FakeCodingAgent({
      script: [{ events: [], throws: new Error("429 rate limited") }],
    });
    const session = await agent.start(SPEC, TOOLBOX, new AbortController().signal);

    await expect(collect(session.run(new AbortController().signal))).rejects.toThrow(
      "429 rate limited",
    );
  });

  it("counts stops rather than refusing a second one", async () => {
    const agent = new FakeCodingAgent();
    const session = await agent.start(SPEC, TOOLBOX, new AbortController().signal);

    await session.stop();
    await session.stop();

    expect(agent.sessions[0]?.stopCount).toBe(2);
    expect(agent.sessions[0]?.stopped).toBe(true);
  });

  it("fails to start when told to", async () => {
    const agent = new FakeCodingAgent({ startFails: new Error("no such model") });

    await expect(agent.start(SPEC, TOOLBOX, new AbortController().signal)).rejects.toThrow(
      "no such model",
    );
  });
});
