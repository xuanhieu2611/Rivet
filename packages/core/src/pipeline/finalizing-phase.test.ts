import type {
  ExternalEffect,
  ImplementationPlan,
  JobDetail,
  PullRequest,
  ReviewReport,
  ValidationReport,
} from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import type { ValidationRecord } from "../events/validation-log";
import type { GitHubPipelineOptions } from "../github/host-git";
import type { WorkspaceSnapshot } from "../checkpoints/workspace-snapshot";
import { JobCancelledError } from "../jobs/failure";
import { SandboxHolder } from "../sandbox/sandbox-holder";
import { finalizingPhase } from "./finalizing-phase";
import type { PipelineOptions } from "./phases";
import type { PhaseArtifactInput, PhaseContext, PhaseEventInput } from "./phase-context";

/**
 * The run's last two writes, against a hand-made context: no database, no
 * Docker, no model.
 *
 * Two claims worth guarding, and they are the two things a reader of a finished
 * job depends on. The summary artifact exists on every path, so its absence
 * means the phase did not run rather than that the model said nothing. And the
 * closing line states the outcome rather than merely that the run ended, which
 * is the whole reason this phase stopped being a sleep.
 */

const JOB = {
  id: "11111111-2222-3333-4444-555555555555",
  reviewLoops: 0,
  reviewDecision: null,
} as unknown as JobDetail;

const STAT = { filesChanged: 1, insertions: 1, deletions: 1 };

function harness(
  options: {
    summary?: string | null;
    validation?: ValidationRecord | null;
    report?: ValidationReport | null;
    job?: JobDetail;
    workspace?: WorkspaceSnapshot;
    plan?: ImplementationPlan | null;
    reviewReport?: ReviewReport | null;
  } = {},
) {
  const controller = new AbortController();
  const events: PhaseEventInput[] = [];
  const artifacts: PhaseArtifactInput[] = [];
  const sequence: string[] = [];

  const ctx: PhaseContext = {
    job: options.job ?? JOB,
    phase: {
      status: "finalizing",
      label: "Finalize",
      durationMs: 2_000,
      recovery: "reconcile_external",
    },
    sandboxes: new SandboxHolder(),
    signal: controller.signal,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },

    // Milestone 9 owns the branch, the commit and the push. Until then this
    // phase touches the container not at all, which is what this rejection is
    // here to keep true.
    exec: () => Promise.reject(new Error("the finalizing phase runs no commands")),
    readBaseline: () => Promise.reject(new Error("the baseline is validation's to compare")),
    readBaselineReport: () => Promise.reject(new Error("the report is validation's to compare")),
    recordProvisioning: () => Promise.reject(new Error("the finalizing phase writes no columns")),
    recordAgentUsage: () => Promise.reject(new Error("the finalizing phase spends nothing")),
    readLatestCheckpoint: () => Promise.resolve(null),
    captureWorkspace: () =>
      options.workspace === undefined
        ? Promise.reject(new Error("no workspace capture here"))
        : Promise.resolve(options.workspace),
    checkpoint: () => Promise.reject(new Error("the finalizing phase records no checkpoints")),

    readSummary: () =>
      Promise.resolve(options.summary === undefined ? "Fixed the comparison." : options.summary),
    readValidation: () =>
      Promise.resolve(
        options.validation === undefined ? { outcome: "fixed", stat: STAT } : options.validation,
      ),
    readValidationReport: () => Promise.resolve(options.report ?? null),
    readImplementationPlan: () => Promise.resolve(options.plan ?? null),
    readLatestReviewReport: () => Promise.resolve(options.reviewReport ?? null),

    event: (input) => {
      events.push(input);
      sequence.push(`event:${input.type}`);
      return Promise.resolve();
    },

    artifact: (input) => {
      artifacts.push(input);
      sequence.push(`artifact:${input.type}`);
      return Promise.resolve(artifacts.length);
    },
  };

  return { ctx, run: () => finalizingPhase()(ctx), controller, events, artifacts, sequence };
}

describe("finalizingPhase", () => {
  it("persists the session's own words as the implementation summary", async () => {
    const test = harness();

    await test.run();

    expect(test.artifacts).toHaveLength(1);
    expect(test.artifacts[0]).toMatchObject({
      type: "implementation_summary",
      content: "Fixed the comparison.",
      metadata: { present: true },
    });
  });

  it("records the absence rather than inventing a summary", async () => {
    // Some sessions end on a tool call. A synthesized summary would be
    // indistinguishable from a real one on the way back out, which is the only
    // property that matters about a record of what a model claimed.
    const test = harness({ summary: null });

    await test.run();

    expect(test.artifacts).toHaveLength(1);
    expect(test.artifacts[0]?.metadata).toEqual({ present: false });
    expect(test.artifacts[0]?.content).toMatch(/without a closing message/);
    expect(test.events[0]?.message).toMatch(/without describing what it changed/);
  });

  it("closes the timeline with the outcome and the diff totals", async () => {
    const test = harness();

    await test.run();

    expect(test.events).toHaveLength(2);
    expect(test.events[0]?.type).toBe("run.summarized");
    expect(test.events[1]).toMatchObject({
      type: "publication.skipped",
      data: { reason: "no_installation" },
    });
    expect(test.events[0]?.data).toEqual({ validation: "fixed", ...STAT, reviewLoops: 0 });
    expect(test.events[0]?.message).toMatch(/fixed/);
    expect(test.events[0]?.message).toMatch(/1 file changed, \+1\/-1/);
  });

  it("distinguishes a bound job when the GitHub provider is disabled", async () => {
    const test = harness({
      job: { ...JOB, githubInstallationId: 42 },
    });

    await test.run();

    expect(test.events.at(-1)).toMatchObject({
      type: "publication.skipped",
      data: { reason: "github_off" },
    });
  });

  it("writes the summary before the publication decision", async () => {
    // Order rather than mere presence: publication failures must not erase the
    // run summary that explains what the validated work came to.
    const test = harness();

    await test.run();

    expect(test.sequence).toEqual([
      "artifact:implementation_summary",
      "event:run.summarized",
      "event:publication.skipped",
    ]);
  });

  it("says a run was not validated differently from one that was unverified", async () => {
    // `unverified` means the comparison ran and had nothing to compare against.
    // No record at all means no comparison happened - a pipeline without an
    // agent - and reporting the second as the first would read as a fault in a
    // job that had none.
    const absent = harness({ validation: null });
    await absent.run();

    const unverified = harness({ validation: { outcome: "unverified" } });
    await unverified.run();

    expect(absent.events[0]?.message).toMatch(/no validation recorded/);
    expect(absent.events[0]?.data).toEqual({ reviewLoops: 0 });
    expect(unverified.events[0]?.message).toMatch(/nothing to compare against/);
    expect(unverified.events[0]?.data).toEqual({ validation: "unverified", reviewLoops: 0 });
  });

  it("states every outcome in its own words", async () => {
    for (const outcome of ["verified", "fixed", "regressed", "unresolved", "unverified"] as const) {
      const test = harness({ validation: { outcome } });
      await test.run();
      expect(test.events[0]?.message).toContain(`Run finished ${outcome}`);
    }
  });

  it("prefers failure attribution and per-check verdicts from the structured report", async () => {
    const test = harness({
      report: validationReport({
        outcome: "regressed",
        attribution: {
          newFailures: ["test/a.test.ts::A", "test/c.test.ts::C"],
          preExistingFailures: ["test/b.test.ts::B", "test/d.test.ts::D", "test/e.test.ts::E"],
          fixedFailures: [],
        },
        typecheck: "verified",
        lint: "verified",
      }),
    });

    await test.run();

    expect(test.events[0]?.message).toContain(
      "Regressed: 2 tests newly failing (3 were already failing), typecheck verified, lint verified (1 file changed, +1/-1).",
    );
  });

  it("states zero new failures, singular pre-existing failures, and fixed failures", async () => {
    const test = harness({
      report: validationReport({
        outcome: "unresolved",
        attribution: {
          newFailures: [],
          preExistingFailures: ["test/b.test.ts::B"],
          fixedFailures: ["test/a.test.ts::A"],
        },
        typecheck: "fixed",
        lint: "unverified",
      }),
    });

    await test.run();

    expect(test.events[0]?.message).toContain(
      "Unresolved: 0 tests newly failing (1 was already failing, 1 was fixed), typecheck fixed, lint unverified (1 file changed, +1/-1).",
    );
  });

  it("uses check outcomes when test attribution was unavailable", async () => {
    const test = harness({
      report: validationReport({
        outcome: "verified",
        typecheck: "verified",
        lint: "fixed",
      }),
    });

    await test.run();

    expect(test.events[0]?.message).toContain(
      "Verified: tests verified, typecheck verified, lint fixed (1 file changed, +1/-1).",
    );
  });

  it("keeps a structured-report closing line clean when diff totals are unavailable", async () => {
    const test = harness({
      validation: { outcome: "verified" },
      report: validationReport({
        outcome: "verified",
        typecheck: "verified",
        lint: "fixed",
      }),
    });

    await test.run();

    expect(test.events[0]?.message).toBe(
      "Verified: tests verified, typecheck verified, lint fixed. The session's own account of the change is recorded.",
    );
  });

  it.each(["verified", "fixed", "regressed", "unresolved", "unverified"] as const)(
    "states %s typecheck and lint verdicts",
    async (outcome) => {
      const test = harness({
        report: validationReport({ outcome, typecheck: outcome, lint: outcome }),
      });

      await test.run();

      expect(test.events[0]?.message).toContain(`typecheck ${outcome}, lint ${outcome}`);
    },
  );

  it("keeps the M5 closing sentence for an old job with no valid report", async () => {
    const test = harness({ report: null, validation: { outcome: "fixed", stat: STAT } });

    await test.run();

    expect(test.events[0]?.message).toBe(
      "Run finished fixed: the suite was failing before the change and passes after it (1 file changed, +1/-1). The session's own account of the change is recorded.",
    );
  });

  it("publishes from the captured tree and keeps the receipt event order", async () => {
    const job = {
      ...JOB,
      title: "Fixed comparison",
      description: "Fix the comparison.",
      repoUrl: "https://github.com/acme/widgets.git",
      baseBranch: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      githubInstallationId: 42,
      repoOwner: "acme",
      repoName: "widgets",
      issueNumber: 17,
      issueUrl: "https://github.com/acme/widgets/issues/17",
    } as JobDetail;
    const test = harness({
      job,
      plan: {
        problemInterpretation: "The check races with the write.",
        relevantComponents: ["booking service"],
        reproductionStrategy: ["Run two requests."],
        implementationApproach: ["Make the write atomic."],
        validationPlan: ["Run the test."],
        riskAreas: ["Old duplicate rows."],
      },
      report: validationReport({
        outcome: "verified",
        typecheck: "verified",
        lint: "verified",
      }),
      workspace: {
        patch: Buffer.from("git patch"),
        treeSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        stats: STAT,
      },
    });
    const effects = new Map<"branch_pushed" | "pull_request_opened", ExternalEffect>();
    const calls: string[] = [];
    const pullRequest: PullRequest = {
      nodeId: "fake-pr-node-1",
      number: 1,
      url: "https://github.com/acme/widgets/pull/1",
      branch: "rivet/job-11111111-fixed-comparison",
      state: "open",
    };
    const github: GitHubPipelineOptions = {
      client: {
        listInstallations: () => Promise.resolve([]),
        listRepositories: () => Promise.resolve([]),
        listIssues: () => Promise.resolve([]),
        mintInstallationToken: () => {
          calls.push("mint");
          return Promise.resolve({
            value: "test-token",
            expiresAt: new Date("2026-08-15T00:00:00.000Z"),
            redact: () => "[REDACTED]",
          });
        },
        getRef: () => {
          calls.push("getRef");
          return Promise.resolve(null);
        },
        findPullRequest: () => {
          calls.push("findPullRequest");
          return Promise.resolve(null);
        },
        createPullRequest: () => {
          calls.push("createPullRequest");
          return Promise.resolve(pullRequest);
        },
        updatePullRequest: () => Promise.reject(new Error("not used")),
      },
      seedClone: () => Promise.reject(new Error("not used")),
      publish: () => {
        calls.push("publish");
        return Promise.resolve({
          ...STAT,
          commitSha: "b".repeat(40),
          treeSha: "a".repeat(40),
          forced: false,
        });
      },
      seedMaxBytes: 8 * 1_024 * 1_024,
      cloneTimeoutMs: 30_000,
      pushTimeoutMs: 30_000,
    };
    test.ctx.readExternalEffect = (kind) => Promise.resolve(effects.get(kind) ?? null);
    test.ctx.recordPublication = (patch) => {
      calls.push(`record:${Object.keys(patch).join(",")}`);
      Object.assign(test.ctx.job, patch);
      return Promise.resolve();
    };
    test.ctx.recordExternalEffect = (input) => {
      const effect: ExternalEffect = {
        id: effects.size + 1,
        jobId: test.ctx.job.id,
        kind: input.kind,
        provider: "github",
        externalId: input.externalId,
        externalUrl: input.externalUrl,
        payload: input.payload ?? null,
        createdAt: new Date("2026-08-15T00:00:00.000Z"),
      };
      effects.set(input.kind, effect);
      test.events.push({
        type: "external_effect.recorded",
        message: "Recorded external effect.",
        data: {
          kind: input.kind,
          provider: "github",
          externalId: input.externalId,
          externalUrl: input.externalUrl,
          adopted: input.adopted,
        },
      });
      test.sequence.push("event:external_effect.recorded");
      return Promise.resolve(effect);
    };

    await finalizingPhase({
      github,
      runUrl: `http://localhost:3000/jobs/${job.id}`,
    } as PipelineOptions)(test.ctx);

    expect(calls).toEqual([
      "getRef",
      "record:finalBranch",
      "mint",
      "publish",
      "findPullRequest",
      "createPullRequest",
      "record:pullRequestNumber,pullRequestUrl",
    ]);
    expect(test.artifacts.map((artifact) => artifact.type)).toEqual([
      "implementation_summary",
      "pull_request_body",
    ]);
    expect(test.events.map((event) => event.type)).toEqual([
      "run.summarized",
      "branch.created",
      "commit.created",
      "push.completed",
      "external_effect.recorded",
      "pull_request.opened",
      "external_effect.recorded",
    ]);
    expect(test.artifacts[1]?.content).toContain("http://localhost:3000/jobs/");
    expect(test.ctx.job.finalBranch).toBe("rivet/job-11111111-fixed-comparison");
    expect(test.ctx.job.pullRequestUrl).toBe(pullRequest.url);
  });

  it("stops on an aborted signal rather than writing to a job that ended", async () => {
    const test = harness();
    test.controller.abort(new JobCancelledError("cancelled while finalizing"));

    await expect(test.run()).rejects.toBeInstanceOf(JobCancelledError);
    expect(test.artifacts).toEqual([]);
    expect(test.events).toEqual([]);
  });
});

function validationReport(input: {
  outcome: ValidationReport["outcome"];
  attribution?: NonNullable<ValidationReport["checks"][number]["attribution"]>;
  typecheck: ValidationReport["outcome"];
  lint: ValidationReport["outcome"];
}): ValidationReport {
  return {
    outcome: input.outcome,
    checks: [
      {
        kind: "test",
        status: input.outcome === "verified" ? "passed" : "failed",
        source: "package_json",
        baseline: input.outcome === "verified" ? "passed" : "failed",
        outcome: input.outcome === "regressed" ? "unresolved" : input.outcome,
        ...(input.attribution ? { attribution: input.attribution } : {}),
      },
      {
        kind: "typecheck",
        status: "passed",
        source: "package_json",
        baseline: "passed",
        outcome: input.typecheck,
      },
      {
        kind: "lint",
        status: "passed",
        source: "package_json",
        baseline: "passed",
        outcome: input.lint,
      },
    ],
  };
}
