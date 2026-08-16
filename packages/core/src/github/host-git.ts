import type { GitHubClient, GitHubToken } from "./github";

/** The host-side result needed to seed a sandbox from an authenticated clone. */
export interface SeedCloneResult {
  /** A complete tar archive containing the repository directory. */
  archive: Uint8Array;
  /** The exact commit checked out before the archive was created. */
  commitSha: string;
  /** The tree at `commitSha`, retained for publication reconciliation. */
  treeSha: string;
}

/** Input accepted by the worker's host Git seed operation. */
export interface SeedCloneRequest {
  remoteUrl: string;
  baseBranch: string;
  /** The immutable commit a recovery attempt must reproduce, when known. */
  baseCommitSha?: string;
  token: Pick<GitHubToken, "value">;
  timeoutMs: number;
  maxArchiveBytes: number;
  signal: AbortSignal;
}

/** The only host-side operation provisioning needs from the Git implementation. */
export type SeedClone = (input: SeedCloneRequest) => Promise<SeedCloneResult>;

/** GitHub dependencies supplied by the worker to the core pipeline. */
export interface GitHubPipelineOptions {
  client: GitHubClient;
  seedClone: SeedClone;
  /** Bound on the complete archive, before it crosses into the sandbox. */
  seedMaxBytes: number;
  /** Host clone and archive timeout, distinct from the sandbox clone timeout. */
  cloneTimeoutMs: number;
}
