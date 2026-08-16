import type {
  CheckComparison,
  PullRequest,
  RepoRef,
  ValidationOutcome,
  ValidationReport,
} from "@rivet/contracts";

import type { ValidationRecord } from "../events/validation-log";
import { GitHubNotInstalledError, PullRequestFailedError } from "../github/errors";
import { deriveBranchName } from "../github/branch-name";
import type { GitHubPipelineOptions } from "../github/host-git";
import {
  composePullRequestBody,
  type PullRequestChangedFile,
  type PullRequestDiffStat,
} from "../github/pull-request-body";
import { decideReconciliation } from "../github/reconcile";
import type { PhaseContext } from "./phase-context";
import type { PipelineOptions } from "./phases";
import type { PhaseDirective } from "./run-pipeline";

/**
 * Phase seven: keep what the session said, say what the run came to, and
 * reconcile the external publication.
 *
 * The summary and `run.summarized` rows remain first. A run that has been
 * validated and reviewed still needs a readable account when GitHub is down,
 * and a pull-request failure must not erase that account. Publication then
 * happens from the lossless workspace patch on the trusted worker host, never
 * from the sandbox or from Pi.
 */
export function finalizingPhase(
  options?: PipelineOptions,
): (ctx: PhaseContext) => Promise<PhaseDirective> {
  return async function finalizing(ctx: PhaseContext): Promise<PhaseDirective> {
    ctx.signal.throwIfAborted();

    const summary = await ctx.readSummary();
    await ctx.artifact({
      type: "implementation_summary",
      content: summary ?? ABSENT_SUMMARY,
      // The one thing a reader cannot recover from the content itself, since
      // the absence is recorded as prose that looks like any other prose.
      metadata: { present: summary !== null },
      message: summary
        ? "Recorded the session's own account of what it changed."
        : "Recorded that the session ended without describing what it changed.",
    });

    const validation = await ctx.readValidation();
    const report = await ctx.readValidationReport();
    await ctx.event({
      type: "run.summarized",
      message: describeRun(validation, summary !== null, report),
      data: {
        ...(validation ? { validation: validation.outcome } : {}),
        ...(validation?.stat ?? {}),
        reviewLoops: ctx.job.reviewLoops ?? 0,
        ...(ctx.job.reviewDecision === null ? {} : { reviewDecision: ctx.job.reviewDecision }),
      },
    });

    ctx.log.info(
      {
        validation: validation?.outcome ?? null,
        validationReport: report?.outcome ?? null,
        ...(validation?.stat ?? {}),
        hasSummary: summary !== null,
      },
      "the run was summarized",
    );

    const installationId = ctx.job.githubInstallationId;
    if (installationId === null || installationId === undefined) {
      await recordPublicationSkipped(ctx, "no_installation");
      return undefined;
    }

    if (!options?.github) {
      await recordPublicationSkipped(ctx, "github_off");
      return undefined;
    }

    const binding = publicationBinding(ctx, installationId);
    await publishValidatedWorkspace(ctx, options, options.github, binding, summary, report);
    return undefined;
  };
}

/**
 * What the artifact says when the session left nothing to say.
 *
 * Some sessions end on a tool call, and the honest response is to record the
 * absence rather than to synthesize a summary from the diff. An invented one
 * would be indistinguishable from a real one on the way back out.
 */
const ABSENT_SUMMARY =
  "The coding session ended without a closing message, so it left no account of what it " +
  "changed or why. Nothing has been written in its place: the diff artifact is the record " +
  "of what actually happened.";

interface PublicationBinding {
  installationId: number;
  repo: RepoRef;
}

function publicationBinding(ctx: PhaseContext, installationId: number): PublicationBinding {
  if (!ctx.job.repoOwner || !ctx.job.repoName) {
    throw new GitHubNotInstalledError(
      `Job ${ctx.job.id} has GitHub installation ${installationId} without a repository binding.`,
    );
  }

  return {
    installationId,
    repo: { owner: ctx.job.repoOwner, name: ctx.job.repoName },
  };
}

async function recordPublicationSkipped(
  ctx: PhaseContext,
  reason: "no_installation" | "github_off",
): Promise<void> {
  await ctx.event({
    type: "publication.skipped",
    message:
      reason === "no_installation"
        ? "GitHub publication skipped because the job has no installation binding."
        : "GitHub publication skipped because the worker has GitHub integration disabled.",
    data: { reason },
  });
}

async function publishValidatedWorkspace(
  ctx: PhaseContext,
  options: PipelineOptions,
  github: GitHubPipelineOptions,
  binding: PublicationBinding,
  summary: string | null,
  validationReport: ValidationReport | null,
): Promise<void> {
  const recordExternalEffect = requireCapability(ctx.recordExternalEffect, "recordExternalEffect");
  const readExternalEffect = requireCapability(ctx.readExternalEffect, "readExternalEffect");
  const recordPublication = requireCapability(ctx.recordPublication, "recordPublication");
  const baseCommitSha = ctx.job.baseCommitSha;
  if (!baseCommitSha) {
    throw new Error(`Job ${ctx.job.id} has no resolved base commit for GitHub publication.`);
  }

  const branch = deriveBranchName(ctx.job.id, ctx.job.title);
  const branchRef = `refs/heads/${branch}`;
  const branchReceipt = await readExternalEffect("branch_pushed");
  ctx.signal.throwIfAborted();
  const remoteRef = await github.client.getRef(binding.installationId, binding.repo, branchRef);
  ctx.signal.throwIfAborted();

  // Capture before selecting or publishing the branch. A failed capture must
  // not leave a job claiming a branch that Rivet never tried to create.
  const workspace = await ctx.captureWorkspace();
  const desiredTreeSha = workspace.treeSha;
  if (!desiredTreeSha) {
    throw new Error(
      "Workspace capture did not return the tree required for publication reconciliation.",
    );
  }

  await recordPublication({ finalBranch: branch });
  await ctx.event({
    type: "branch.created",
    message: `Publication branch selected: ${branch}.`,
    data: {
      branch,
      baseBranch: ctx.job.baseBranch,
      baseCommitSha,
    },
  });

  const action = decideReconciliation({
    receipt: branchReceipt,
    remoteRef,
    desiredTreeSha,
  });

  let commitSha: string;
  let treeSha: string;
  let filesChanged = workspace.stats.filesChanged;
  let insertions = workspace.stats.insertions;
  let deletions = workspace.stats.deletions;
  let forced = false;

  if (action === "adopt") {
    if (!remoteRef) {
      throw new Error("An adopt reconciliation decision requires a remote branch ref.");
    }
    commitSha = remoteRef.commitSha;
    treeSha = remoteRef.treeSha;
  } else {
    const token = await github.client.mintInstallationToken(
      binding.installationId,
      binding.repo,
      "write",
    );
    const published = await github.publish({
      remoteUrl: ctx.job.repoUrl,
      baseBranch: ctx.job.baseBranch,
      baseCommitSha,
      branch,
      patch: workspace.patch,
      token,
      timeoutMs: github.pushTimeoutMs,
      expectedRemoteCommitSha: remoteRef?.commitSha ?? null,
      commitMessage: `Rivet: ${ctx.job.title}`,
      signal: ctx.signal,
    });
    commitSha = published.commitSha;
    treeSha = published.treeSha;
    filesChanged = published.filesChanged;
    insertions = published.insertions;
    deletions = published.deletions;
    forced = action === "force_push";
  }

  if (treeSha !== desiredTreeSha) {
    throw new Error(
      `Host publication produced tree ${treeSha}, but the validated workspace produced ${desiredTreeSha}.`,
    );
  }

  await ctx.event({
    type: "commit.created",
    message: `Committed the validated tree on ${branch}.`,
    data: {
      branch,
      commitSha,
      treeSha,
      filesChanged,
      insertions,
      deletions,
    },
  });

  if (action !== "adopt") {
    await ctx.event({
      type: "push.completed",
      message: `${forced ? "Force-updated" : "Pushed"} ${branch} to GitHub.`,
      data: { branch, commitSha, treeSha, forced },
    });
  }

  const branchUrl = branchUrlFor(binding.repo, branch);
  await recordExternalEffect({
    kind: "branch_pushed",
    provider: "github",
    externalId: commitSha,
    externalUrl: branchUrl,
    payload: { branch, commitSha, treeSha },
    adopted: action === "adopt",
  });

  const plan = ctx.readImplementationPlan ? await ctx.readImplementationPlan() : null;
  const reviewReport = ctx.readLatestReviewReport ? await ctx.readLatestReviewReport() : null;
  const diffStat = await readDiffStat(ctx);
  const body = composePullRequestBody({
    job: {
      id: ctx.job.id,
      title: ctx.job.title,
      description: ctx.job.description,
      issueUrl: ctx.job.issueUrl,
    },
    plan,
    implementationSummary: summary,
    diffStat: diffStat ?? {
      filesChanged,
      insertions,
      deletions,
    },
    validationReport,
    reviewReport,
    runUrl: runUrlFor(options, ctx.job.id),
  });
  const bodyArtifactId = await ctx.artifact({
    type: "pull_request_body",
    content: body,
    requireComplete: true,
    message: "Pull request body artifact recorded.",
  });

  const pullRequestReceipt = await readExternalEffect("pull_request_opened");
  ctx.signal.throwIfAborted();
  const existing = await github.client.findPullRequest(
    binding.installationId,
    binding.repo,
    branch,
  );
  if (!existing && pullRequestReceipt) {
    throw new PullRequestFailedError(
      `GitHub no longer returns pull request ${pullRequestReceipt.externalId} for publication branch ${branch}.`,
    );
  }

  let pullRequest: PullRequest;
  let adopted = false;
  let updated = false;

  if (existing) {
    adopted = true;
    if (existing.state === "open") {
      pullRequest = await github.client.updatePullRequest({
        installationId: binding.installationId,
        repo: binding.repo,
        number: existing.number,
        title: ctx.job.title,
        body,
      });
      updated = true;
    } else {
      // A closed or merged PR is still the external result. Rivet must not
      // reopen somebody else's decision just because a worker resumed.
      pullRequest = existing;
    }
  } else {
    pullRequest = await github.client.createPullRequest({
      installationId: binding.installationId,
      repo: binding.repo,
      head: branch,
      base: ctx.job.baseBranch,
      title: ctx.job.title,
      body,
    });
  }

  await ctx.event({
    type: adopted ? "pull_request.adopted" : "pull_request.opened",
    message: adopted
      ? `Adopted pull request #${pullRequest.number}.`
      : `Opened pull request #${pullRequest.number}.`,
    data: {
      number: pullRequest.number,
      url: pullRequest.url,
      branch,
      state: pullRequest.state,
      bodyArtifactId,
      ...(adopted ? { updated } : {}),
    },
  });

  await recordExternalEffect({
    kind: "pull_request_opened",
    provider: "github",
    externalId: pullRequest.nodeId,
    externalUrl: pullRequest.url,
    payload: {
      number: pullRequest.number,
      branch,
      state: pullRequest.state,
    },
    adopted,
  });
  await recordPublication({
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url,
  });

  ctx.log.info(
    {
      branch,
      commitSha,
      treeSha,
      forced,
      pullRequestNumber: pullRequest.number,
      adopted,
    },
    "publication completed",
  );
}

async function readDiffStat(ctx: PhaseContext): Promise<PullRequestDiffStat | null> {
  if (!ctx.readLatestArtifactContent) return null;
  const content = await ctx.readLatestArtifactContent("diff_stat");
  if (content === null) return null;

  const stat: PullRequestDiffStat = {
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    paths: [],
  };
  const paths: string[] = [];
  const files: PullRequestChangedFile[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const insertions = parseDiffCount(fields[0]);
    const deletions = parseDiffCount(fields[1]);
    if (insertions === undefined || deletions === undefined) continue;
    const path = fields.slice(2).join("\t").trim();
    if (path.length === 0) continue;
    stat.filesChanged += 1;
    if (insertions !== null) stat.insertions += insertions;
    if (deletions !== null) stat.deletions += deletions;
    paths.push(path);
    files.push({ path, insertions, deletions });
  }
  stat.paths = paths;
  stat.files = files;
  return stat;
}

function parseDiffCount(value: string | undefined): number | null | undefined {
  if (value === "-") return null;
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  return Number(value);
}

/**
 * The link a pull request carries back to the run that produced it.
 *
 * Relative when no base URL is configured. That is a deliberately imperfect
 * fallback: it is right in the app and wrong in a pull request body, which is a
 * visible missing link rather than a silent one pointing at somebody else's
 * deployment.
 */
function runUrlFor(options: PipelineOptions, jobId: string): string {
  const path = `/jobs/${jobId}`;
  const base = options.appBaseUrl?.replace(/\/+$/u, "");
  return base ? `${base}${path}` : path;
}

function branchUrlFor(repo: RepoRef, branch: string): string {
  return `https://github.com/${repo.owner}/${repo.name}/tree/${encodeURIComponent(branch)}`;
}

function requireCapability<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`GitHub publication requires the PhaseContext.${name} capability.`);
  }
  return value;
}

/** The closing line: the comparison, the size of the change, and the summary. */
function describeRun(
  validation: ValidationRecord | null,
  hasSummary: boolean,
  report: ValidationReport | null,
): string {
  const said = hasSummary
    ? "The session's own account of the change is recorded."
    : "The session ended without describing what it changed.";

  if (report) {
    return `${describeReport(report, validation)} ${said}`;
  }

  if (!validation) {
    // Not `unverified`, and the wording keeps them apart: that outcome means the
    // comparison ran and had nothing to compare against, where this means no
    // comparison happened - a pipeline built without an agent, so `testing` was
    // still a sleep. Reporting the second as the first would read as a fault in
    // a job that had none.
    return `Run finished with no validation recorded, so nothing is claimed about whether the change works. ${said}`;
  }

  return `Run finished ${validation.outcome}: ${OUTCOME_SENTENCES[validation.outcome]}${describeStat(validation)}. ${said}`;
}

function describeReport(report: ValidationReport, validation: ValidationRecord | null): string {
  const verdicts: string[] = [];
  const test = report.checks.find((check) => check.kind === "test");
  if (test) verdicts.push(describeTest(test));

  for (const kind of ["typecheck", "lint"] as const) {
    const check = report.checks.find((candidate) => candidate.kind === kind);
    if (check) verdicts.push(`${kind} ${check.outcome}`);
  }

  const outcome = `${report.outcome[0]?.toUpperCase() ?? ""}${report.outcome.slice(1)}`;
  const stat = validation ? describeStat(validation) : "";
  return verdicts.length > 0 ? `${outcome}: ${verdicts.join(", ")}${stat}.` : `${outcome}${stat}.`;
}

function describeTest(check: CheckComparison): string {
  if (!check.attribution) return `tests ${check.outcome}`;

  const attribution = check.attribution;
  const details = [
    attribution.preExistingFailures.length > 0
      ? `${countWithVerb(attribution.preExistingFailures.length, "was", "were")} already failing`
      : null,
    attribution.fixedFailures.length > 0
      ? `${countWithVerb(attribution.fixedFailures.length, "was", "were")} fixed`
      : null,
  ].filter((detail): detail is string => detail !== null);

  const newlyFailing = `${plural(attribution.newFailures.length, "test")} newly failing`;
  return details.length > 0 ? `${newlyFailing} (${details.join(", ")})` : newlyFailing;
}

function countWithVerb(count: number, singularVerb: string, pluralVerb: string): string {
  return `${count} ${count === 1 ? singularVerb : pluralVerb}`;
}

const OUTCOME_SENTENCES: Record<ValidationOutcome, string> = {
  verified: "the suite passed before the change and passes after it",
  fixed: "the suite was failing before the change and passes after it",
  regressed: "the change broke a suite that was green",
  unresolved: "the suite was failing before the change and is still failing",
  unverified: "there was nothing to compare against, so the change was not checked",
};

function describeStat(validation: ValidationRecord): string {
  const stat = validation.stat;
  if (!stat) return "";
  return ` (${plural(stat.filesChanged, "file")} changed, +${stat.insertions}/-${stat.deletions})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
