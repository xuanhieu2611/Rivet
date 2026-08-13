import { isTerminal, JOB_STATUSES, type JobStatus } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  assertTransitionAllowed,
  IllegalTransitionError,
} from "./transitions";

/**
 * The guard table is pure data, so all of it is testable with no database.
 * `transitionJob` itself needs a real Postgres transaction and is covered by
 * the integration suite instead.
 */

describe("ALLOWED_TRANSITIONS", () => {
  it("has an entry for every JobStatus", () => {
    // The real guard here is `Record<JobStatus, ...>`, which fails typecheck
    // when a status is added without an edge list. This asserts it at runtime
    // too, so a status added to the pgEnum alone cannot slip through.
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...JOB_STATUSES].sort());
  });

  it("only names statuses that exist", () => {
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      for (const target of targets) {
        expect(JOB_STATUSES).toContain(target);
      }
    }
  });

  it("gives terminal statuses no outgoing edges", () => {
    for (const status of JOB_STATUSES) {
      if (isTerminal(status)) {
        expect(ALLOWED_TRANSITIONS[status]).toEqual([]);
      }
    }
  });

  it("leaves no non-terminal status stranded", () => {
    for (const status of JOB_STATUSES) {
      if (!isTerminal(status)) {
        expect(ALLOWED_TRANSITIONS[status].length).toBeGreaterThan(0);
      }
    }
  });

  it("lets a sweeper requeue every in-flight status", () => {
    // The reclaim path. `queued` is excluded only because it is already there.
    for (const status of JOB_STATUSES) {
      if (!isTerminal(status) && status !== "queued") {
        expect(ALLOWED_TRANSITIONS[status]).toContain("queued");
      }
    }
  });

  it("lists no status twice", () => {
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      expect(new Set(targets).size).toBe(targets.length);
    }
  });
});

describe("assertTransitionAllowed", () => {
  it("accepts every edge in the table", () => {
    for (const status of JOB_STATUSES) {
      for (const target of ALLOWED_TRANSITIONS[status]) {
        expect(() => {
          assertTransitionAllowed(status, target);
        }).not.toThrow();
      }
    }
  });

  it("rejects every edge absent from the table", () => {
    for (const status of JOB_STATUSES) {
      for (const target of JOB_STATUSES) {
        if (ALLOWED_TRANSITIONS[status].includes(target)) continue;
        expect(() => {
          assertTransitionAllowed(status, target);
        }).toThrow(IllegalTransitionError);
      }
    }
  });

  it("rejects the specific shortcuts a caller is most likely to attempt", () => {
    const illegal: [JobStatus, JobStatus][] = [
      // Skipping the pipeline entirely.
      ["queued", "completed"],
      ["queued", "testing"],
      // Resurrecting a terminal job.
      ["completed", "queued"],
      ["failed", "implementing"],
      ["cancelled", "queued"],
      ["timed_out", "queued"],
      // Running the pipeline backwards.
      ["reviewing", "planning"],
      ["finalizing", "implementing"],
      // A status to itself: the compare-and-swap would always succeed, so this
      // must fail on the guard rather than write a no-op event.
      ["implementing", "implementing"],
    ];

    for (const [from, to] of illegal) {
      expect(() => {
        assertTransitionAllowed(from, to);
      }).toThrow(IllegalTransitionError);
    }
  });

  it("requires every status in a `from` set to permit the target", () => {
    // Both members legal.
    expect(() => {
      assertTransitionAllowed(["testing", "reviewing"], "failed");
    }).not.toThrow();

    // `reviewing -> revising` is legal, `testing -> revising` is not, so the
    // set as a whole is rejected. A partially-legal set would let a
    // compare-and-swap make an illegal move whenever it matched the wrong half.
    expect(() => {
      assertTransitionAllowed(["testing", "reviewing"], "revising");
    }).toThrow(IllegalTransitionError);
  });

  it("names the offending pair in the error", () => {
    expect(() => {
      assertTransitionAllowed("completed", "queued");
    }).toThrow(/completed -> queued/);
  });
});
