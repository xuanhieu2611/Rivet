import { isTerminal, JOB_STATUSES } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import {
  JOB_FILTERS,
  JOB_FILTER_STATUSES,
  jobFilterHref,
  jobFilterStatuses,
  parseJobFilter,
} from "./job-filter";

describe("parseJobFilter", () => {
  it("accepts every tab and falls back to all", () => {
    for (const filter of JOB_FILTERS) {
      expect(parseJobFilter(filter)).toBe(filter);
    }
    expect(parseJobFilter(undefined)).toBe("all");
    expect(parseJobFilter("")).toBe("all");
    expect(parseJobFilter("provisioning")).toBe("all");
    expect(parseJobFilter(["running", "failed"])).toBe("running");
  });
});

describe("JOB_FILTER_STATUSES", () => {
  it("defines running as every non-terminal status, so a new one lands there", () => {
    const running = JOB_FILTER_STATUSES.running ?? [];

    expect([...running].sort()).toEqual(
      JOB_STATUSES.filter((status) => !isTerminal(status)).sort(),
    );
    expect(running.every((status) => !isTerminal(status))).toBe(true);
  });

  it("keeps failed to the statuses that are actually failures", () => {
    expect(JOB_FILTER_STATUSES.failed).toEqual(["failed", "budget_exceeded", "timed_out"]);
    expect(JOB_FILTER_STATUSES.failed).not.toContain("cancelled");
  });

  it("does not filter at all on the default tab", () => {
    expect(JOB_FILTER_STATUSES.all).toBeNull();
    expect(jobFilterStatuses("all")).toBeUndefined();
    expect(jobFilterStatuses("completed")).toEqual(["completed"]);
  });

  it("covers every status exactly once across running, completed and failed, bar cancelled", () => {
    const covered = [
      ...(JOB_FILTER_STATUSES.running ?? []),
      ...(JOB_FILTER_STATUSES.completed ?? []),
      ...(JOB_FILTER_STATUSES.failed ?? []),
    ];

    expect(new Set(covered).size).toBe(covered.length);
    expect(JOB_STATUSES.filter((status) => !covered.includes(status))).toEqual(["cancelled"]);
  });
});

describe("jobFilterHref", () => {
  it("keeps the default tab on the bare path", () => {
    expect(jobFilterHref("all")).toBe("/jobs");
    expect(jobFilterHref("running")).toBe("/jobs?status=running");
  });
});
