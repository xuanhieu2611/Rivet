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

/** The change totals returned by the host publication operation. */
export interface PublishChangeStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Input for applying a validated patch and updating a GitHub branch. */
export interface PublishRequest {
  remoteUrl: string;
  baseBranch: string;
  baseCommitSha: string;
  branch: string;
  patch: Uint8Array;
  token: Pick<GitHubToken, "value">;
  timeoutMs: number;
  /** Null means the branch was observed to be absent. */
  expectedRemoteCommitSha: string | null;
  commitMessage: string;
  signal: AbortSignal;
}

/** The commit and tree produced by a host publication. */
export interface PublishResult extends PublishChangeStats {
  commitSha: string;
  treeSha: string;
  forced: boolean;
}

/** The only host-side operation finalizing needs to publish a patch. */
export type Publish = (input: PublishRequest) => Promise<PublishResult>;

/** GitHub dependencies supplied by the worker to the core pipeline. */
export interface GitHubPipelineOptions {
  client: GitHubClient;
  seedClone: SeedClone;
  publish: Publish;
  /** Bound on the complete archive, before it crosses into the sandbox. */
  seedMaxBytes: number;
  /** Host clone and archive timeout, distinct from the sandbox clone timeout. */
  cloneTimeoutMs: number;
  /** Host publication clone, apply, commit and push timeout. */
  pushTimeoutMs: number;
}
