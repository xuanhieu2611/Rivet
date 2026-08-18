import type { CodingAgentRole } from "../agent/coding-agent";
import { scanPromptInjection, type InjectionPatternClass } from "./prompt-injection";
import type { PhaseContext } from "./phase-context";

export type UntrustedSource =
  "issue_title" | "issue_body" | "repository" | "file" | "command_output" | "agent_artifact";

export type PromptScanBoundary = "context" | "tool";

export interface ScanUntrustedInput {
  source: UntrustedSource;
  location: string;
  text: string;
  boundary: PromptScanBoundary;
  agentRole?: CodingAgentRole;
}

/**
 * Records detection as best-effort observability. A broken event write, a
 * malformed source, or a lost lease must never change the agent workflow.
 */
export async function scanAndRecordUntrusted(
  ctx: PhaseContext,
  input: ScanUntrustedInput,
): Promise<InjectionPatternClass[]> {
  const result = scanPromptInjection(input.text);
  if (result.patternClasses.length === 0) return result.patternClasses;

  try {
    await ctx.event({
      type: "security.injection_suspected",
      message: `Prompt-injection pattern suspected in ${input.source}.`,
      data: {
        source: input.source,
        location: input.location,
        patternClasses: result.patternClasses,
        scanBoundary: input.boundary,
        ...(input.agentRole === undefined ? {} : { agentRole: input.agentRole }),
        ...(result.truncated ? { scanTruncated: true } : {}),
      },
    });
  } catch (error) {
    // Detection is explicitly non-blocking. The event is useful, but it is not
    // worth turning a successful coding session into a failed job.
    ctx.log.warn(
      { err: error, source: input.source, location: input.location },
      "could not record prompt-injection detection",
    );
  }

  return result.patternClasses;
}

export async function scanTaskInputs(ctx: PhaseContext, role: CodingAgentRole): Promise<void> {
  await scanAndRecordUntrusted(ctx, {
    source: "issue_title",
    location: "task.title",
    text: ctx.job.title,
    boundary: "context",
    agentRole: role,
  });
  await scanAndRecordUntrusted(ctx, {
    source: "issue_body",
    location: "task.description",
    text: ctx.job.description,
    boundary: "context",
    agentRole: role,
  });
}
