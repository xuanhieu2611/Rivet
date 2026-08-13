/**
 * `@rivet/sandbox` - the only package in Rivet that knows Docker exists.
 *
 * `@rivet/core` declares the `Sandbox` port; this implements it twice, once
 * with dockerode for the real system and once with a scripted fake for tests.
 * Exactly the split `@rivet/queue` makes for Redis, and for the same reason:
 * keeping the adapter out of core is what lets "the domain runs anywhere" be a
 * fact about the dependency graph rather than a claim in a comment.
 *
 * The same laziness rule as `@rivet/database` and `@rivet/queue` applies, and
 * here it is the strictest of the three: **importing this package never
 * connects to the daemon and never throws.** `pnpm build` and `pnpm test` both
 * run in CI with no Docker at all.
 */

export { dockerConnectionTarget, getDocker, resetDocker } from "./connection";
export {
  DockerSandboxProvider,
  type DockerSandboxOptions,
  LABEL_CREATED_AT,
  LABEL_JOB_ID,
  LABEL_WORKER_ID,
  SANDBOX_NETWORK,
  type SandboxLogger,
} from "./docker-sandbox";
export {
  type ArgvMatcher,
  FakeSandbox,
  FakeSandboxProvider,
  type FakeSandboxOptions,
  type ScriptedCommand,
} from "./fake-sandbox";
export { CappedOutput, DockerStreamDemuxer, encodeFrame } from "./stream";
