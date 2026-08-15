import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CodingAgent } from "@rivet/core";

/**
 * Loads the `CodingAgent` behind `RIVET_AGENT=scripted`.
 *
 * The mode exists for `pnpm demo:recovery`, which needs two real worker
 * processes - one of them killed with `kill -9` mid-session - running the same
 * production entrypoint as every other job, but not sampling a model. A model
 * asked the same question twice does not do the same thing twice, and a
 * demonstration of *recovery* that can fail because the replacement session
 * chose a different file is a demonstration of nothing.
 *
 * The module is named by a path rather than being a table of built-in scripts,
 * so the fixture-specific knowledge lives with the demo that needs it instead
 * of in the worker's wiring. Loading is dynamic and late for the same reason
 * the Pi SDK is: `import`ing a demo script at worker startup would make every
 * production boot depend on a file that only a demo has.
 */
export interface ScriptedAgentModule {
  createCodingAgent: () => CodingAgent;
}

export class ScriptedAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptedAgentError";
  }
}

export async function loadScriptedAgent(
  scriptPath: string,
  from: string = process.cwd(),
): Promise<CodingAgent> {
  const absolute = isAbsolute(scriptPath) ? scriptPath : resolve(from, scriptPath);

  let module: unknown;
  try {
    module = (await import(pathToFileURL(absolute).href)) as unknown;
  } catch (error) {
    throw new ScriptedAgentError(
      `RIVET_AGENT_SCRIPT could not be loaded from ${absolute}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const factory = (module as Partial<ScriptedAgentModule>).createCodingAgent;
  if (typeof factory !== "function") {
    throw new ScriptedAgentError(
      `RIVET_AGENT_SCRIPT at ${absolute} must export createCodingAgent(): CodingAgent.`,
    );
  }

  const agent = factory();
  if (typeof agent?.start !== "function") {
    throw new ScriptedAgentError(
      `createCodingAgent() in ${absolute} did not return a CodingAgent: it has no start().`,
    );
  }
  return agent;
}
