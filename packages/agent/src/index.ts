/**
 * `@rivet/agent` - the only package in Rivet that knows Pi exists.
 *
 * `@rivet/core` declares the `CodingAgent` port; this implements it twice, once
 * with the Pi SDK for the real system and once with a scripted fake for tests.
 * Exactly the split `@rivet/sandbox` makes for Docker and `@rivet/queue` makes
 * for Redis, and for the same reason: keeping the adapter out of core is what
 * makes "the domain runs anywhere" a fact about the dependency graph rather
 * than a claim in a comment.
 *
 * The laziness rule applies here as strictly as anywhere: **importing this
 * package loads no SDK, reads no configuration and never throws.** The harness
 * is loaded on the first `start()` and memoised. `pnpm build` and `pnpm test`
 * both run in CI with no model key at all, and this is what keeps that true.
 */

export { EventBuffer, type EventBufferOptions } from "./event-buffer";
export { accumulate, emptyUsage, PiEventMapper, type SessionProgress } from "./event-mapper";
export {
  approvingReview,
  FakeCodingAgent,
  type FakeCodingAgentOptions,
  FakeCodingAgentSession,
  revisingReview,
  type ScriptedSession,
} from "./fake-agent";
export { AgentPathError, resolveInside } from "./paths";
export {
  type AgentLogger,
  classifyHarnessError,
  PiCodingAgent,
  type PiCodingAgentOptions,
  RIVET_PLANNER_TOOL_NAMES,
  RIVET_REVIEWER_TOOL_NAMES,
  RIVET_TOOL_NAMES,
  toolNamesForRole,
} from "./pi-agent";
export {
  createReadOnlyFileOperations,
  createToolOperations,
  type ReadOnlyAgentToolbox,
  type ReadOnlyFileLayerOptions,
  type ToolLayerOptions,
  type ToolOperations,
  withToolCall,
} from "./tools";
