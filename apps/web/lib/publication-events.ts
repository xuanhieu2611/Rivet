import type { JobEvent, JobEventType } from "@rivet/contracts";

/** A link a reader can follow out of the timeline into GitHub. */
export interface PublicationEventLink {
  href: string;
  text: string;
}

/** The structured presentation used for the eight GitHub publication events. */
export interface PublicationEventPresentation {
  label: string;
  emphasis: "neutral" | "positive" | "negative";
  explanation: string;
  facts: readonly string[];
  link: PublicationEventLink | null;
}

export const PUBLICATION_EVENT_TYPES = [
  "github.repository_bound",
  "branch.created",
  "commit.created",
  "push.completed",
  "pull_request.opened",
  "pull_request.adopted",
  "publication.skipped",
  "external_effect.recorded",
] as const satisfies readonly JobEventType[];

const PUBLICATION_EVENT_TYPE_SET: ReadonlySet<string> = new Set(PUBLICATION_EVENT_TYPES);

export function isPublicationEvent(event: JobEvent): boolean {
  return PUBLICATION_EVENT_TYPE_SET.has(event.type);
}

/**
 * The publication half of the timeline, in the terms a reader came for.
 *
 * These are the only events in the log that describe something Rivet did
 * outside itself, so each one states what became true on GitHub rather than
 * what changed in Postgres. `push.completed` and `pull_request.opened` are the
 * two rows somebody watching a demo looks for, which is why both carry a
 * followable link where one exists.
 */
export function describePublicationEvent(event: JobEvent): PublicationEventPresentation | null {
  switch (event.type) {
    case "github.repository_bound":
      return describeRepositoryBound(event);
    case "branch.created":
      return describeBranchCreated(event);
    case "commit.created":
      return describeCommitCreated(event);
    case "push.completed":
      return describePushCompleted(event);
    case "pull_request.opened":
    case "pull_request.adopted":
      return describePullRequest(event);
    case "publication.skipped":
      return describePublicationSkipped(event);
    case "external_effect.recorded":
      return describeExternalEffect(event);
    default:
      return null;
  }
}

function describeRepositoryBound(event: JobEvent): PublicationEventPresentation {
  const data = event.data;
  const repo = data?.owner && data?.repo ? `${data.owner}/${data.repo}` : null;

  return {
    label: "Repository bound",
    emphasis: "neutral",
    explanation:
      "The job runs against a GitHub App installation, so the worker seeds the sandbox from a host clone and the container never receives a credential.",
    facts: compact([
      repo,
      data?.private === undefined ? null : data.private ? "private" : "public",
      data?.installationId === undefined ? null : `installation ${String(data.installationId)}`,
      data?.issueNumber === undefined ? null : `issue #${String(data.issueNumber)}`,
    ]),
    link: repo ? { href: `https://github.com/${repo}`, text: repo } : null,
  };
}

function describeBranchCreated(event: JobEvent): PublicationEventPresentation {
  const data = event.data;

  return {
    label: "Branch selected",
    emphasis: "neutral",
    explanation:
      "The branch name is derived from the job's immutable fields rather than generated, so a resumed attempt can ask GitHub what the previous one already did.",
    facts: compact([
      data?.branch ?? null,
      data?.baseBranch ? `from ${data.baseBranch}` : null,
      data?.baseCommitSha ? `at ${shortSha(data.baseCommitSha)}` : null,
    ]),
    link: null,
  };
}

function describeCommitCreated(event: JobEvent): PublicationEventPresentation {
  const data = event.data;

  return {
    label: "Commit created",
    emphasis: "neutral",
    explanation:
      "One squashed commit carrying the exact tree that was validated and reviewed. The turn-by-turn history stays in the job's checkpoints.",
    facts: compact([
      data?.commitSha ? `commit ${shortSha(data.commitSha)}` : null,
      data?.treeSha ? `tree ${shortSha(data.treeSha)}` : null,
      diffStat(data?.filesChanged, data?.insertions, data?.deletions),
    ]),
    link: null,
  };
}

function describePushCompleted(event: JobEvent): PublicationEventPresentation {
  const data = event.data;

  return {
    label: data?.forced ? "Branch force-updated" : "Pushed",
    emphasis: "positive",
    explanation: data?.forced
      ? "The branch already existed with a different tree, so this resumed attempt replaced it with the newer validated one. The branch is Rivet's own."
      : "The validated tree is now on GitHub. This is the first thing in the run that cannot be undone by a database transaction.",
    facts: compact([
      data?.branch ?? null,
      data?.commitSha ? `commit ${shortSha(data.commitSha)}` : null,
    ]),
    link: null,
  };
}

function describePullRequest(event: JobEvent): PublicationEventPresentation {
  const data = event.data;
  const adopted = event.type === "pull_request.adopted";
  const number = data?.number === undefined ? null : `#${String(data.number)}`;

  return {
    label: adopted ? "Pull request adopted" : "Pull request opened",
    emphasis: "positive",
    explanation: adopted
      ? data?.updated
        ? "A pull request from this branch already existed, so Rivet refreshed its body instead of opening a second one."
        : "A pull request from this branch already existed and is no longer open. Rivet reports it rather than reopening somebody else's decision."
      : "The deliverable. Its body is composed from the plan, summary, validation report and review verdict already durable in Postgres.",
    facts: compact([
      number,
      data?.state ?? null,
      data?.branch ?? null,
      data?.bodyArtifactId === undefined ? null : `body artifact #${String(data.bodyArtifactId)}`,
    ]),
    link: data?.url
      ? { href: data.url, text: number ? `View ${number}` : "View pull request" }
      : null,
  };
}

const SKIP_REASONS = {
  no_installation: {
    explanation:
      "The job carries no GitHub App installation, so there is nowhere to publish. It was created from a plain repository URL and its result is the validated diff.",
    fact: "no installation binding",
  },
  github_off: {
    explanation:
      "This worker runs with GitHub integration disabled, so the pipeline stops at the validated diff. Production refuses that configuration.",
    fact: "RIVET_GITHUB=off",
  },
} as const;

function describePublicationSkipped(event: JobEvent): PublicationEventPresentation {
  const reason = event.data?.reason;
  const detail = reason ? SKIP_REASONS[reason] : null;

  return {
    label: "Publication skipped",
    emphasis: "neutral",
    explanation:
      detail?.explanation ??
      "Publication was deliberately not attempted, so this run produced no branch and no pull request.",
    facts: compact([detail?.fact ?? null]),
    link: null,
  };
}

function describeExternalEffect(event: JobEvent): PublicationEventPresentation {
  const data = event.data;
  const kind = data?.kind === "pull_request_opened" ? "pull request" : "branch push";

  return {
    label: "Receipt recorded",
    emphasis: "neutral",
    explanation:
      "The external effect is now acknowledged in Postgres. A worker that dies after this row exists resumes knowing the effect already happened, which is what keeps one job to one branch and one pull request.",
    facts: compact([
      kind,
      data?.provider ?? null,
      data?.externalId ? shortSha(data.externalId) : null,
      data?.adopted === undefined ? null : data.adopted ? "adopted" : "new",
    ]),
    link: data?.externalUrl ? { href: data.externalUrl, text: "Open on GitHub" } : null,
  };
}

function diffStat(
  filesChanged: number | undefined,
  insertions: number | undefined,
  deletions: number | undefined,
): string | null {
  if (filesChanged === undefined || insertions === undefined || deletions === undefined) {
    return null;
  }
  return `${String(filesChanged)} ${filesChanged === 1 ? "file" : "files"}, +${String(insertions)}/-${String(deletions)}`;
}

/**
 * Shortened only when it looks like a hex object name.
 *
 * A pull request receipt's `externalId` is GitHub's node id, which is opaque
 * base64 and means nothing at seven characters.
 */
function shortSha(value: string): string {
  return /^[0-9a-f]{40}$/u.test(value) ? value.slice(0, 7) : value;
}

function compact(values: readonly (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null && value.length > 0);
}
