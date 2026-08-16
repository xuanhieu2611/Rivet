import type { JobEvent, JobEventData, JobEventType } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  describePublicationEvent,
  isPublicationEvent,
  PUBLICATION_EVENT_TYPES,
} from "./publication-events";

function event(type: JobEventType, data?: JobEventData): JobEvent {
  return {
    id: 1,
    jobId: "11111111-2222-3333-4444-555555555555",
    type,
    message: "message",
    ...(data ? { data } : { data: null }),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("isPublicationEvent", () => {
  it("covers every publication type and nothing else", () => {
    for (const type of PUBLICATION_EVENT_TYPES) {
      expect(isPublicationEvent(event(type))).toBe(true);
    }
    expect(isPublicationEvent(event("review.recorded"))).toBe(false);
    expect(isPublicationEvent(event("phase.completed"))).toBe(false);
  });

  it("describes every type it claims", () => {
    for (const type of PUBLICATION_EVENT_TYPES) {
      expect(describePublicationEvent(event(type))).not.toBeNull();
    }
    expect(describePublicationEvent(event("review.recorded"))).toBeNull();
  });
});

describe("describePublicationEvent", () => {
  it("links a bound repository to its GitHub page", () => {
    const presentation = describePublicationEvent(
      event("github.repository_bound", {
        installationId: 42,
        owner: "acme",
        repo: "widgets",
        private: true,
        issueNumber: 9,
      }),
    );

    expect(presentation?.facts).toEqual(["acme/widgets", "private", "installation 42", "issue #9"]);
    expect(presentation?.link).toEqual({
      href: "https://github.com/acme/widgets",
      text: "acme/widgets",
    });
  });

  it("shortens object names but leaves the branch and base alone", () => {
    const presentation = describePublicationEvent(
      event("branch.created", {
        branch: "rivet/job-11111111-health-check",
        baseBranch: "main",
        baseCommitSha: COMMIT,
      }),
    );

    expect(presentation?.facts).toEqual([
      "rivet/job-11111111-health-check",
      "from main",
      "at 0123456",
    ]);
  });

  it("states the diff the commit carries", () => {
    const presentation = describePublicationEvent(
      event("commit.created", {
        commitSha: COMMIT,
        treeSha: COMMIT,
        filesChanged: 1,
        insertions: 12,
        deletions: 3,
      }),
    );

    expect(presentation?.facts).toEqual(["commit 0123456", "tree 0123456", "1 file, +12/-3"]);
  });

  it("says a force update replaced an older tree rather than calling it an ordinary push", () => {
    const plain = describePublicationEvent(event("push.completed", { branch: "b", forced: false }));
    const forced = describePublicationEvent(event("push.completed", { branch: "b", forced: true }));

    expect(plain?.label).toBe("Pushed");
    expect(forced?.label).toBe("Branch force-updated");
    expect(forced?.explanation).toContain("resumed attempt");
  });

  it("links an opened pull request, which is the row a demo viewer looks for", () => {
    const presentation = describePublicationEvent(
      event("pull_request.opened", {
        number: 4,
        url: "https://github.com/acme/widgets/pull/4",
        branch: "rivet/job-11111111",
        state: "open",
        bodyArtifactId: 18,
      }),
    );

    expect(presentation?.label).toBe("Pull request opened");
    expect(presentation?.emphasis).toBe("positive");
    expect(presentation?.link).toEqual({
      href: "https://github.com/acme/widgets/pull/4",
      text: "View #4",
    });
  });

  it("separates an adopted-and-updated pull request from an adopted closed one", () => {
    const updated = describePublicationEvent(
      event("pull_request.adopted", { number: 4, state: "open", updated: true }),
    );
    const closed = describePublicationEvent(
      event("pull_request.adopted", { number: 4, state: "merged", updated: false }),
    );

    expect(updated?.explanation).toContain("refreshed its body");
    expect(closed?.explanation).toContain("no longer open");
  });

  it("names the reason publication was skipped", () => {
    expect(
      describePublicationEvent(event("publication.skipped", { reason: "no_installation" }))?.facts,
    ).toEqual(["no installation binding"]);
    expect(
      describePublicationEvent(event("publication.skipped", { reason: "github_off" }))?.facts,
    ).toEqual(["RIVET_GITHUB=off"]);
  });

  it("leaves an opaque pull-request node id intact while shortening a commit sha", () => {
    const branch = describePublicationEvent(
      event("external_effect.recorded", {
        kind: "branch_pushed",
        provider: "github",
        externalId: COMMIT,
        externalUrl: "https://github.com/acme/widgets/tree/rivet/job",
        adopted: false,
      }),
    );
    const pull = describePublicationEvent(
      event("external_effect.recorded", {
        kind: "pull_request_opened",
        provider: "github",
        externalId: "PR_kwDOABCD",
        externalUrl: "https://github.com/acme/widgets/pull/4",
        adopted: true,
      }),
    );

    expect(branch?.facts).toEqual(["branch push", "github", "0123456", "new"]);
    expect(pull?.facts).toEqual(["pull request", "github", "PR_kwDOABCD", "adopted"]);
  });

  it("omits facts the event did not carry rather than printing undefined", () => {
    for (const type of PUBLICATION_EVENT_TYPES) {
      const presentation = describePublicationEvent(event(type));
      expect(presentation?.facts.join(" ")).not.toContain("undefined");
      expect(presentation?.link).toBeNull();
    }
  });
});
