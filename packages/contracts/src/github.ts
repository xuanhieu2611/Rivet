import { z } from "zod";

/** The states Rivet reports for a pull request, including merged PRs. */
export const PULL_REQUEST_STATES = ["open", "closed", "merged"] as const;

export const pullRequestStateSchema = z.enum(PULL_REQUEST_STATES);

export type PullRequestState = z.infer<typeof pullRequestStateSchema>;

/** The external effects whose receipts are persisted by Rivet. */
export const EXTERNAL_EFFECT_KINDS = ["branch_pushed", "pull_request_opened"] as const;

export const externalEffectKindSchema = z.enum(EXTERNAL_EFFECT_KINDS);

export type ExternalEffectKind = z.infer<typeof externalEffectKindSchema>;

/** The external provider used by Milestone 9 receipts. */
export const EXTERNAL_EFFECT_PROVIDERS = ["github"] as const;

export const externalEffectProviderSchema = z.enum(EXTERNAL_EFFECT_PROVIDERS);

export type ExternalEffectProvider = z.infer<typeof externalEffectProviderSchema>;

/** Why publication was deliberately skipped rather than attempted. */
export const PUBLICATION_SKIP_REASONS = ["no_installation", "github_off"] as const;

export const publicationSkipReasonSchema = z.enum(PUBLICATION_SKIP_REASONS);

export type PublicationSkipReason = z.infer<typeof publicationSkipReasonSchema>;

/** The owner and repository name used by GitHub API calls. */
export interface RepoRef {
  owner: string;
  name: string;
}

/** The GitHub App installation data Rivet exposes to the control plane. */
export interface Installation {
  id: number;
  accountLogin: string;
  accountType: string;
  targetType: string;
  permissions: Record<string, string>;
  suspended: boolean;
}

/** A repository available through an App installation. */
export interface Repository extends RepoRef {
  id: number;
  private: boolean;
  defaultBranch: string;
}

/** An issue available for use as a job's task. */
export interface Issue {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  state: "open" | "closed";
}

/** A pull request returned by the GitHub adapter. */
export interface PullRequest {
  /** GitHub's node id, used as the durable external-effect id. */
  nodeId: string;
  number: number;
  url: string;
  branch: string;
  state: PullRequestState;
}

/** A durable receipt for an external GitHub effect. */
export interface ExternalEffect {
  id: number;
  jobId: string;
  kind: ExternalEffectKind;
  provider: ExternalEffectProvider;
  externalId: string;
  externalUrl: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}
