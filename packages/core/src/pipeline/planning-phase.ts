import {
  parseImplementationPlan,
  serializeImplementationPlan,
  type ImplementationPlan,
} from "@rivet/contracts";

import { PlanNotProducedError } from "../agent/errors";
import type { PlannerAgentToolbox, CodingAgentSpec } from "../agent/coding-agent";
import { commandKilledError } from "../sandbox/errors";
import { buildAgentContext, parseCostCeiling } from "./implementing-phase";
import { runAgentSession } from "./agent-session";
import type { PhaseContext } from "./phase-context";
import type { AgentOptions, PipelineOptions } from "./phases";
import { REPO_DIRNAME } from "./project";

/**
 * Phase three: create and persist the structured implementation plan.
 *
 * Planning is a separate read-only role. The model can inspect the repository
 * progressively and can submit only a Zod-validated plan. An assistant message
 * that resembles JSON is deliberately not enough: the durable acknowledgement
 * is the successful `submit_plan` capability call followed by the artifact and
 * timeline writes below.
 */
export function planningPhase(
  agent: AgentOptions,
  options: PipelineOptions,
): (ctx: PhaseContext) => Promise<void> {
  const repoDir = `${options.workdir}/${REPO_DIRNAME}`;

  return async function planning(ctx: PhaseContext): Promise<void> {
    ctx.signal.throwIfAborted();
    const sandbox = ctx.sandboxes.require();
    let submittedPlan: ImplementationPlan | undefined;

    const toolbox: PlannerAgentToolbox = {
      role: "planner",
      listFiles: (signal) =>
        runReadOnlyCommand(ctx, options, repoDir, ["git", "ls-files"], signal, agent.fileMaxBytes),
      readFile: (path, signal) => sandbox.getFile(path, { maxBytes: agent.fileMaxBytes }, signal),
      searchText: (query, signal) => {
        if (query.trim().length === 0) {
          return Promise.reject(new Error("search_text requires a non-empty query."));
        }
        return runReadOnlyCommand(
          ctx,
          options,
          repoDir,
          ["git", "grep", "-n", "--no-color", "-e", query, "--", "."],
          signal,
          agent.fileMaxBytes,
        );
      },
      submitPlan: (value, signal) => {
        signal.throwIfAborted();
        if (submittedPlan !== undefined) {
          return Promise.reject(
            new Error("A planning session may submit only one implementation plan."),
          );
        }
        submittedPlan = parseImplementationPlan(value);
        return Promise.resolve();
      },
    };

    const spec: CodingAgentSpec = {
      role: "planner",
      workdir: repoDir,
      task: { title: ctx.job.title, description: ctx.job.description },
      context: await buildAgentContext(ctx, options, repoDir, "planner"),
      sessionTimeoutMs: agent.sessionTimeoutMs,
      commandTimeoutMs: options.commandTimeoutMs,
      previewMaxBytes: agent.previewMaxBytes,
      limits: {
        maxTurns: agent.maxTurns,
        maxToolCalls: ctx.job.maxToolCalls,
        maxModelCalls: ctx.job.maxModelCalls,
        maxCostUsd: parseCostCeiling(ctx.job.maxCostUsd),
      },
    };

    await runAgentSession(agent, spec, toolbox, ctx);
    ctx.signal.throwIfAborted();

    if (submittedPlan === undefined) {
      throw new PlanNotProducedError(
        "The planning session ended without a valid submit_plan call. A JSON assistant message is not a persisted plan.",
      );
    }

    const artifactId = await ctx.artifact({
      type: "implementation_plan",
      content: serializeImplementationPlan(submittedPlan),
      requireComplete: true,
      message: "Implementation plan artifact recorded.",
    });

    await ctx.event({
      type: "plan.recorded",
      message: "Implementation plan recorded.",
      data: {
        artifactId,
        artifactType: "implementation_plan",
        agentRole: "planner",
      },
    });

    ctx.log.info({ artifactId }, "planning completed with a structured plan");
  };
}

async function runReadOnlyCommand(
  ctx: PhaseContext,
  options: PipelineOptions,
  repoDir: string,
  argv: string[],
  signal: AbortSignal,
  maxOutputBytes: number,
): Promise<string> {
  signal.throwIfAborted();
  const result = await ctx.exec({
    argv,
    cwd: repoDir,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes,
  });
  ctx.signal.throwIfAborted();
  const killed = commandKilledError(result);
  if (killed) throw killed;
  return result.stdout;
}
