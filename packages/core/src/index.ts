/**
 * `@rivet/core` - Rivet's domain logic, shared by every deployable.
 *
 * The package exists so that `apps/web` and the Milestone 1 worker run the same
 * job logic instead of two copies of it. Four rules keep it that way, and they
 * are the point of the package rather than incidental style:
 *
 * - No `next/*` imports. The web app is one consumer, not the owner.
 * - No `bullmq` or `ioredis` imports. Core declares the queue port; the adapter
 *   in `packages/queue` is the only thing that knows Redis exists.
 * - No `process.env` reads. Configuration arrives as function arguments, which
 *   is what lets tests drive the pipeline with zero-millisecond phases.
 * - Every module lives under one of `jobs/`, `events/`, `pipeline/`, `queue/`.
 *   A file at the top level next to this one is the first sign the package is
 *   turning into a junk drawer.
 */

export * from "./events/event-service";
export * from "./jobs/job-service";
export * from "./jobs/transitions";
