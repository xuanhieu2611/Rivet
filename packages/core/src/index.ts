/**
 * `@rivet/core` - Rivet's domain logic, shared by every deployable.
 *
 * The package exists so that `apps/web` and the Milestone 1 worker run the same
 * job logic instead of two copies of it. Four rules keep it that way, and they
 * are the point of the package rather than incidental style:
 *
 * - No `next/*` imports. The web app is one consumer, not the owner.
 * - No `bullmq`, `ioredis`, `dockerode` or `@earendil-works/*` imports. Core
 *   declares the queue, sandbox and coding-agent ports; the adapters in
 *   `packages/queue`, `packages/sandbox` and `packages/agent` are the only
 *   things that know Redis, Docker and Pi exist.
 * - No `process.env` reads. Configuration arrives as function arguments, which
 *   is what lets tests drive the pipeline with zero-millisecond phases.
 * - Every module lives under one of `agent/`, `artifacts/`, `checkpoints/`, `jobs/`,
 *   `events/`, `pipeline/`, `queue/`, `sandbox/`.
 *   A file at the top level next to this one is the first sign the package is
 *   turning into a junk drawer.
 */

export * from "./agent/errors";
export * from "./artifacts/artifact-store";
export * from "./checkpoints/checkpoint-store";
export * from "./checkpoints/workspace-snapshot";
export * from "./events/baseline-log";
export * from "./events/baseline-report";
export * from "./events/event-service";
export * from "./events/session-log";
export * from "./events/review-log";
export * from "./events/validation-log";
export * from "./github/effect-store";
export * from "./jobs/agent-usage";
export * from "./jobs/cancel";
export * from "./jobs/claims";
export * from "./jobs/deadline";
export * from "./jobs/enqueue";
export * from "./jobs/failure";
export * from "./jobs/job-service";
export * from "./jobs/lease";
export * from "./jobs/provisioning";
export * from "./jobs/review";
export * from "./jobs/sweeper";
export * from "./jobs/transitions";
export * from "./pipeline/baseline-phase";
export * from "./pipeline/agent-session";
export * from "./pipeline/command-output";
export * from "./pipeline/check-runner";
export * from "./pipeline/finalizing-phase";
export * from "./pipeline/implementing-phase";
export * from "./pipeline/phase-context";
export * from "./pipeline/phases";
export * from "./pipeline/planning-phase";
export * from "./pipeline/project";
export * from "./pipeline/project-probe";
export * from "./pipeline/provisioning-phase";
export * from "./pipeline/revising-phase";
export * from "./pipeline/reviewing-phase";
export * from "./pipeline/resume-plan";
export * from "./pipeline/run-pipeline";
export * from "./pipeline/validation-phase";
export * from "./pipeline/validation-config";
export * from "./pipeline/test-report";
export * from "./pipeline/targeted-tests";
export * from "./sandbox/command-log";
export * from "./sandbox/errors";
export * from "./sandbox/sandbox-holder";
// Types only: the port is an interface, and the adapter that implements it
// lives in `@rivet/queue`. That is the whole point of the split.
export type * from "./queue/job-queue";
// The same split again, for the same reason: the sandbox port is an interface
// and `@rivet/sandbox` is where dockerode lives.
export type * from "./sandbox/sandbox";
// And a third time. `@rivet/agent` is where Pi lives, and where a model key is
// the difference between a package that can be imported and one that cannot.
export type * from "./agent/coding-agent";
