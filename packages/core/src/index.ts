/**
 * `@rivet/core` - Rivet's domain logic, shared by every deployable.
 *
 * The package exists so that `apps/web` and the Milestone 1 worker run the same
 * job logic instead of two copies of it. Four rules keep it that way, and they
 * are the point of the package rather than incidental style:
 *
 * - No `next/*` imports. The web app is one consumer, not the owner.
 * - No `bullmq`, `ioredis` or `dockerode` imports. Core declares the queue and
 *   sandbox ports; the adapters in `packages/queue` and `packages/sandbox` are
 *   the only things that know Redis and Docker exist.
 * - No `process.env` reads. Configuration arrives as function arguments, which
 *   is what lets tests drive the pipeline with zero-millisecond phases.
 * - Every module lives under one of `jobs/`, `events/`, `pipeline/`, `queue/`,
 *   `sandbox/`.
 *   A file at the top level next to this one is the first sign the package is
 *   turning into a junk drawer.
 */

export * from "./events/event-service";
export * from "./jobs/cancel";
export * from "./jobs/claims";
export * from "./jobs/enqueue";
export * from "./jobs/failure";
export * from "./jobs/job-service";
export * from "./jobs/sweeper";
export * from "./jobs/transitions";
export * from "./pipeline/phases";
export * from "./pipeline/run-pipeline";
export * from "./sandbox/command-log";
export * from "./sandbox/errors";
// Types only: the port is an interface, and the adapter that implements it
// lives in `@rivet/queue`. That is the whole point of the split.
export type * from "./queue/job-queue";
// The same split again, for the same reason: the sandbox port is an interface
// and `@rivet/sandbox` is where dockerode lives.
export type * from "./sandbox/sandbox";
