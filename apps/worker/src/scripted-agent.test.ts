import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadScriptedAgent, ScriptedAgentError } from "./scripted-agent";

/**
 * The loader behind `RIVET_AGENT=scripted`.
 *
 * Every case here is a way the demo could look armed while being wrong, and all
 * of them fail at startup rather than on the first job: a worker that boots with
 * no session to run would provision a container and clone a repository before
 * discovering it.
 */
async function moduleWith(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rivet-scripted-agent-"));
  const path = join(directory, "agent.mjs");
  await writeFile(path, source, "utf8");
  return path;
}

describe("loadScriptedAgent", () => {
  it("returns the agent the module's factory builds", async () => {
    const path = await moduleWith(
      "export function createCodingAgent() { return { start: () => Promise.resolve({}) }; }",
    );

    const agent = await loadScriptedAgent(path);

    expect(typeof agent.start).toBe("function");
  });

  it("resolves a relative path against the directory it is given", async () => {
    const path = await moduleWith("export const createCodingAgent = () => ({ start() {} });");
    const [directory, file] = [join(path, ".."), "agent.mjs"];

    await expect(loadScriptedAgent(`./${file}`, directory)).resolves.toBeDefined();
  });

  it("names the path it could not load", async () => {
    await expect(loadScriptedAgent("/nope/missing-agent.mjs")).rejects.toThrow(
      /could not be loaded from \/nope\/missing-agent\.mjs/,
    );
  });

  it("refuses a module that exports no factory", async () => {
    const path = await moduleWith("export const somethingElse = 1;");

    await expect(loadScriptedAgent(path)).rejects.toThrow(ScriptedAgentError);
    await expect(loadScriptedAgent(path)).rejects.toThrow(/must export createCodingAgent/);
  });

  it("refuses a factory that does not return a CodingAgent", async () => {
    const path = await moduleWith("export function createCodingAgent() { return { run() {} }; }");

    await expect(loadScriptedAgent(path)).rejects.toThrow(/has no start\(\)/);
  });
});
