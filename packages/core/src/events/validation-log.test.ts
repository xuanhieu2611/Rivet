import { serializeValidationReport } from "@rivet/contracts";
import { describe, expect, it } from "vitest";

import { type ValidationEventLike, validationFrom, validationReportFrom } from "./validation-log";

/**
 * The read side of the validation record, against a synthetic event list.
 *
 * Same shape and same argument as `baseline-log.test.ts`: the selection is the
 * logic, and `readValidation` is one query around it.
 */

const recorded = (data: Record<string, unknown> | null): ValidationEventLike => ({
  type: "validation.recorded",
  data,
});

const STAT = { filesChanged: 2, insertions: 7, deletions: 3 };

describe("validationFrom", () => {
  it("reads the outcome and the diff totals back together", () => {
    expect(validationFrom([recorded({ validation: "fixed", ...STAT })])).toEqual({
      outcome: "fixed",
      stat: STAT,
    });
  });

  it("returns null when nothing was validated, which is not `unverified`", () => {
    // `unverified` means the comparison ran and had nothing to compare against;
    // null means no comparison happened at all - a pipeline built without an
    // agent, where `testing` is still a sleep. The closing line says something
    // different for each.
    expect(validationFrom([])).toBeNull();
    expect(
      validationFrom([{ type: "baseline.recorded", data: { baseline: "failed" } }]),
    ).toBeNull();
    expect(validationFrom([recorded({ validation: "unverified" })])).toEqual({
      outcome: "unverified",
    });
  });

  it("keeps the outcome when the totals are missing or unusable", () => {
    // All three or none: they are one parse of one command, so a row carrying
    // two of them is a broken row rather than a partial diff.
    expect(validationFrom([recorded({ validation: "verified" })])).toEqual({ outcome: "verified" });
    expect(
      validationFrom([recorded({ validation: "verified", filesChanged: 1, insertions: 2 })]),
    ).toEqual({ outcome: "verified" });
    expect(validationFrom([recorded({ validation: "verified", ...STAT, deletions: "3" })])).toEqual(
      {
        outcome: "verified",
      },
    );
  });

  it("ignores every other event type, including one carrying the same key", () => {
    expect(
      validationFrom([
        { type: "job.completed", data: { validation: "verified" } },
        recorded({ validation: "regressed", ...STAT }),
      ]),
    ).toEqual({ outcome: "regressed", stat: STAT });
  });

  it("prefers the latest, and falls back past a row that cannot be read", () => {
    expect(
      validationFrom([recorded({ validation: "unresolved" }), recorded({ validation: "fixed" })]),
    ).toEqual({ outcome: "fixed" });
    expect(
      validationFrom([
        recorded({ validation: "fixed" }),
        recorded(null),
        recorded({ validation: "green" }),
      ]),
    ).toEqual({ outcome: "fixed" });
  });
});

const REPORT = serializeValidationReport({
  outcome: "verified",
  checks: [
    {
      kind: "test",
      status: "passed",
      source: "package_json",
      baseline: "passed",
      outcome: "verified",
    },
  ],
});

describe("validationReportFrom", () => {
  it("reads a complete canonical validation report", () => {
    expect(validationReportFrom([{ content: REPORT, truncated: false }])).toEqual({
      outcome: "verified",
      checks: [
        {
          kind: "test",
          status: "passed",
          source: "package_json",
          baseline: "passed",
          outcome: "verified",
        },
      ],
    });
  });

  it.each([
    ["missing", []],
    ["truncated", [{ content: REPORT, truncated: true }]],
    ["malformed", [{ content: "{", truncated: false }]],
    [
      "schema-invalid",
      [{ content: '{"outcome":"verified","checks":[],"extra":true}', truncated: false }],
    ],
  ] as const)("returns null for a %s latest artifact", (_name, rows) => {
    expect(validationReportFrom(rows)).toBeNull();
  });

  it("does not silently substitute an older report for a malformed latest attempt", () => {
    expect(
      validationReportFrom([
        { content: "{", truncated: false },
        { content: REPORT, truncated: false },
      ]),
    ).toBeNull();
  });
});
